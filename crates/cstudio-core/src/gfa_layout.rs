//! Independent deterministic multilevel force layout for GFA graphs.
//!
//! This module is implemented from graph-drawing principles: multilevel
//! coarsening, spring attraction, Barnes-Hut repulsion, level refinement, and
//! connected-component packing. It does not depend on OGDF or Bandage code.

use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};

const PATH_SEGMENT_LENGTH: f64 = 48.0;
const GFA_EDGE_LENGTH: f64 = 42.0;
const MAX_LEVELS: usize = 7;
const MIN_COARSE_VERTICES: usize = 24;
const UNITIG_SPRING_WEIGHT: f64 = 2.0;
const GFA_LINK_SPRING_WEIGHT: f64 = 1.35;
const LINEARITY_SPRING_WEIGHT: f64 = 1.1;
const BLOCK_UNIT_SPRING_WEIGHT: f64 = 4.0;
const CHAIN_TARGET_EXTENSION_RATIO: f64 = 0.82;
const CHAIN_CURVE_RETAIN_RATIO: f64 = 0.42;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GfaLayoutPoint {
    pub x: f64,
    pub y: f64,
}

impl GfaLayoutPoint {
    fn zero() -> Self {
        Self { x: 0.0, y: 0.0 }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GfaLayoutSide {
    Start,
    End,
}

#[derive(Debug, Clone, PartialEq)]
pub struct GfaLayoutNode {
    pub id: String,
    pub width: f64,
    pub reverse: bool,
    pub layout_unit_id: String,
    pub layout_order: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GfaLayoutEdge {
    pub source: String,
    pub target: String,
    pub source_side: GfaLayoutSide,
    pub target_side: GfaLayoutSide,
}

#[derive(Debug, Clone, PartialEq)]
pub struct GfaLayoutPath {
    pub id: String,
    pub points: Vec<GfaLayoutPoint>,
}

#[derive(Debug, Clone, Copy)]
struct Spring {
    source: usize,
    target: usize,
    length: f64,
    weight: f64,
}

#[derive(Debug, Clone)]
struct LayoutLevel {
    masses: Vec<f64>,
    springs: Vec<Spring>,
    fine_to_coarse: Option<Vec<usize>>,
}

#[derive(Debug)]
struct ComponentLayout {
    node_indices: Vec<usize>,
    paths: Vec<Vec<GfaLayoutPoint>>,
}

#[derive(Debug)]
struct ParticleChain {
    particles: Vec<usize>,
    lengths: Vec<f64>,
}

/**
 * Layout every valid node and every valid GFA edge. Input order and stable ids
 * are the only seeds, so repeated runs are byte-for-byte deterministic on the
 * same target architecture.
 */
pub fn layout_gfa_multilevel(
    nodes: &[GfaLayoutNode],
    edges: &[GfaLayoutEdge],
) -> Vec<GfaLayoutPath> {
    if nodes.is_empty() {
        return Vec::new();
    }

    let node_index = nodes
        .iter()
        .enumerate()
        .map(|(index, node)| (node.id.as_str(), index))
        .collect::<HashMap<_, _>>();
    let valid_edges = edges
        .iter()
        .filter_map(|edge| {
            let source = *node_index.get(edge.source.as_str())?;
            let target = *node_index.get(edge.target.as_str())?;
            (source != target).then_some((source, target, edge))
        })
        .collect::<Vec<_>>();
    let components = connected_components(nodes, &valid_edges);
    let mut layouts = components
        .iter()
        .map(|component| layout_component(nodes, &valid_edges, component))
        .collect::<Vec<_>>();
    layouts.sort_by(|left, right| {
        right
            .node_indices
            .len()
            .cmp(&left.node_indices.len())
            .then_with(|| left.node_indices[0].cmp(&right.node_indices[0]))
    });
    pack_components(&mut layouts, nodes.len());

    let mut paths_by_node = vec![Vec::new(); nodes.len()];
    for component in layouts {
        for (local_index, node_index) in component.node_indices.into_iter().enumerate() {
            paths_by_node[node_index] = component.paths[local_index].clone();
        }
    }
    nodes
        .iter()
        .enumerate()
        .map(|(index, node)| GfaLayoutPath {
            id: node.id.clone(),
            points: paths_by_node[index].clone(),
        })
        .collect()
}

fn connected_components(
    nodes: &[GfaLayoutNode],
    edges: &[(usize, usize, &GfaLayoutEdge)],
) -> Vec<Vec<usize>> {
    let mut adjacency = vec![Vec::new(); nodes.len()];
    for &(source, target, _) in edges {
        adjacency[source].push(target);
        adjacency[target].push(source);
    }
    let mut layout_units = BTreeMap::<&str, Vec<usize>>::new();
    for (index, node) in nodes.iter().enumerate() {
        layout_units
            .entry(node.layout_unit_id.as_str())
            .or_default()
            .push(index);
    }
    for members in layout_units.values_mut() {
        members.sort_by_key(|index| (nodes[*index].layout_order, *index));
        for pair in members.windows(2) {
            adjacency[pair[0]].push(pair[1]);
            adjacency[pair[1]].push(pair[0]);
        }
    }
    for neighbors in &mut adjacency {
        neighbors.sort_unstable();
        neighbors.dedup();
    }
    let mut visited = vec![false; nodes.len()];
    let mut components = Vec::new();
    for start in 0..nodes.len() {
        if visited[start] {
            continue;
        }
        let mut queue = VecDeque::from([start]);
        let mut component = Vec::new();
        visited[start] = true;
        while let Some(current) = queue.pop_front() {
            component.push(current);
            for &neighbor in &adjacency[current] {
                if !visited[neighbor] {
                    visited[neighbor] = true;
                    queue.push_back(neighbor);
                }
            }
        }
        component.sort_unstable();
        components.push(component);
    }
    components
}

fn layout_component(
    nodes: &[GfaLayoutNode],
    edges: &[(usize, usize, &GfaLayoutEdge)],
    component: &[usize],
) -> ComponentLayout {
    if component.len() == 1 {
        let node_index = component[0];
        let node = &nodes[node_index];
        let width = safe_width(node.width);
        let count = control_point_count(width);
        let angle = deterministic_angle(&node.id, 41);
        let axis = GfaLayoutPoint {
            x: angle.cos(),
            y: angle.sin(),
        };
        let normal = GfaLayoutPoint {
            x: -axis.y,
            y: axis.x,
        };
        let bend_sign = if deterministic_angle(&node.id, 97).sin() >= 0.0 {
            1.0
        } else {
            -1.0
        };
        let bend = if count > 2 {
            width.min(720.0) * 0.14 * bend_sign
        } else {
            0.0
        };
        return ComponentLayout {
            node_indices: vec![node_index],
            paths: vec![(0..count)
                .map(|index| {
                    let ratio = index as f64 / (count - 1) as f64;
                    let offset = -width / 2.0 + width * ratio;
                    let curve = (std::f64::consts::PI * ratio).sin() * bend;
                    GfaLayoutPoint {
                        x: axis.x * offset + normal.x * curve,
                        y: axis.y * offset + normal.y * curve,
                    }
                })
                .collect()],
        };
    }

    let local_by_global = component
        .iter()
        .enumerate()
        .map(|(local, global)| (*global, local))
        .collect::<HashMap<_, _>>();
    let mut particle_ranges = Vec::with_capacity(component.len());
    let mut particle_count = 0usize;
    let mut springs = Vec::new();
    for &global_index in component {
        let width = safe_width(nodes[global_index].width);
        let point_count = control_point_count(width);
        let start = particle_count;
        particle_count += point_count;
        particle_ranges.push(start..particle_count);
        let segment_length = width / (point_count - 1) as f64;
        for point_index in start..particle_count - 1 {
            springs.push(Spring {
                source: point_index,
                target: point_index + 1,
                length: segment_length,
                weight: UNITIG_SPRING_WEIGHT,
            });
        }
    }
    let mut layout_units = BTreeMap::<&str, Vec<(usize, usize)>>::new();
    let mut block_junctions = Vec::new();
    for (local_index, &global_index) in component.iter().enumerate() {
        layout_units
            .entry(nodes[global_index].layout_unit_id.as_str())
            .or_default()
            .push((local_index, global_index));
    }
    for members in layout_units.values_mut() {
        members.sort_by_key(|(_, global_index)| (nodes[*global_index].layout_order, *global_index));
        for pair in members.windows(2) {
            let source = particle_ranges[pair[0].0].end - 1;
            let target = particle_ranges[pair[1].0].start;
            springs.push(Spring {
                source,
                target,
                length: 0.0,
                weight: BLOCK_UNIT_SPRING_WEIGHT,
            });
            block_junctions.push((source, target));
        }
    }
    for &(source_global, target_global, edge) in edges {
        let (Some(&source_local), Some(&target_local)) = (
            local_by_global.get(&source_global),
            local_by_global.get(&target_global),
        ) else {
            continue;
        };
        if nodes[source_global].layout_unit_id == nodes[target_global].layout_unit_id {
            continue;
        }
        let source = physical_endpoint_particle(
            &particle_ranges[source_local],
            nodes[source_global].reverse,
            edge.source_side,
        );
        let target = physical_endpoint_particle(
            &particle_ranges[target_local],
            nodes[target_global].reverse,
            edge.target_side,
        );
        springs.push(Spring {
            source,
            target,
            length: GFA_EDGE_LENGTH,
            weight: GFA_LINK_SPRING_WEIGHT,
        });
    }
    let linear_chains = add_chain_linearity_springs(&mut springs, particle_count);

    let fine = LayoutLevel {
        masses: vec![1.0; particle_count],
        springs,
        fine_to_coarse: None,
    };
    let levels = build_levels(fine);
    let mut positions = solve_levels(&levels, component, nodes);
    shape_open_particle_chains(&mut positions, &linear_chains);
    for (source, target) in block_junctions {
        let midpoint = GfaLayoutPoint {
            x: (positions[source].x + positions[target].x) / 2.0,
            y: (positions[source].y + positions[target].y) / 2.0,
        };
        positions[source] = midpoint;
        positions[target] = midpoint;
    }
    let mut paths = particle_ranges
        .into_iter()
        .map(|range| positions[range].to_vec())
        .collect::<Vec<_>>();
    rotate_component_horizontally(&mut paths);

    ComponentLayout {
        node_indices: component.to_vec(),
        paths,
    }
}

/**
 * Every degree-two particle is part of an unbranched graph path. Connecting
 * its two neighbours with their combined rest length makes the local triangle
 * degenerate towards a straight line. Repeating that constraint along a path
 * yields Bandage-like linear spines, while branch vertices remain free and
 * all-degree-two cycles relax into smooth rings.
 */
fn add_chain_linearity_springs(
    springs: &mut Vec<Spring>,
    particle_count: usize,
) -> Vec<ParticleChain> {
    let mut adjacency = vec![Vec::<(usize, f64)>::new(); particle_count];
    for spring in springs.iter() {
        add_particle_neighbor(&mut adjacency[spring.source], spring.target, spring.length);
        add_particle_neighbor(&mut adjacency[spring.target], spring.source, spring.length);
    }
    let mut linearity_springs = Vec::new();
    for neighbors in &adjacency {
        if neighbors.len() != 2 || neighbors[0].0 == neighbors[1].0 {
            continue;
        }
        linearity_springs.push(Spring {
            source: neighbors[0].0,
            target: neighbors[1].0,
            length: neighbors[0].1 + neighbors[1].1,
            weight: LINEARITY_SPRING_WEIGHT,
        });
    }

    // A two-hop constraint smooths local corners but still lets a long path
    // fold back on itself. Trace every maximal path between tips/branches and
    // add progressively longer chords. Their rest length equals the traversed
    // path length, so unbranched topology is encouraged to occupy one axis.
    let mut visited_edges = BTreeSet::new();
    let mut chains = Vec::new();
    for start in 0..adjacency.len() {
        if adjacency[start].len() == 2 {
            continue;
        }
        for &(first, first_length) in &adjacency[start] {
            let edge_key = ordered_particle_edge(start, first);
            if visited_edges.contains(&edge_key) {
                continue;
            }
            let chain = trace_open_particle_chain(
                start,
                first,
                first_length,
                &adjacency,
                &mut visited_edges,
            );
            add_multiscale_chain_chords(&chain.particles, &chain.lengths, &mut linearity_springs);
            chains.push(chain);
        }
    }
    springs.extend(linearity_springs);
    chains
}

fn trace_open_particle_chain(
    start: usize,
    first: usize,
    first_length: f64,
    adjacency: &[Vec<(usize, f64)>],
    visited_edges: &mut BTreeSet<(usize, usize)>,
) -> ParticleChain {
    let mut particles = vec![start, first];
    let mut lengths = vec![first_length];
    let mut previous = start;
    let mut current = first;
    visited_edges.insert(ordered_particle_edge(start, first));
    while adjacency[current].len() == 2 {
        let Some(&(next, length)) = adjacency[current]
            .iter()
            .find(|neighbor| neighbor.0 != previous)
        else {
            break;
        };
        let edge_key = ordered_particle_edge(current, next);
        if visited_edges.contains(&edge_key) {
            break;
        }
        visited_edges.insert(edge_key);
        particles.push(next);
        lengths.push(length);
        previous = current;
        current = next;
    }
    ParticleChain { particles, lengths }
}

fn shape_open_particle_chains(positions: &mut [GfaLayoutPoint], chains: &[ParticleChain]) {
    let force_positions = positions.to_vec();
    let mut incidence = vec![0usize; positions.len()];
    for chain in chains {
        if let (Some(&start), Some(&end)) = (chain.particles.first(), chain.particles.last()) {
            incidence[start] += 1;
            incidence[end] += 1;
        }
    }

    // Give each maximal path an overall direction without making it rigid.
    // A target shorter than the full rest length leaves room for a visible arc.
    for _ in 0..48 {
        for chain in chains {
            let (Some(&start), Some(&end)) = (chain.particles.first(), chain.particles.last())
            else {
                continue;
            };
            if start == end {
                continue;
            }
            let rest_length = chain.lengths.iter().sum::<f64>();
            let target_extension = rest_length * CHAIN_TARGET_EXTENSION_RATIO;
            let dx = positions[end].x - positions[start].x;
            let dy = positions[end].y - positions[start].y;
            let distance = dx.hypot(dy).max(0.001);
            let direction = GfaLayoutPoint {
                x: dx / distance,
                y: dy / distance,
            };
            let start_flex = if incidence[start] <= 1 { 1.0 } else { 0.28 };
            let end_flex = if incidence[end] <= 1 { 1.0 } else { 0.28 };
            let flex_total = start_flex + end_flex;
            let correction = (distance - target_extension) * 0.28;
            positions[start].x += direction.x * correction * start_flex / flex_total;
            positions[start].y += direction.y * correction * start_flex / flex_total;
            positions[end].x -= direction.x * correction * end_flex / flex_total;
            positions[end].y -= direction.y * correction * end_flex / flex_total;
        }
    }

    for chain in chains {
        let (Some(&start), Some(&end)) = (chain.particles.first(), chain.particles.last()) else {
            continue;
        };
        if start == end || chain.lengths.is_empty() {
            continue;
        }
        let start_position = positions[start];
        let end_position = positions[end];
        let force_start = force_positions[start];
        let force_end = force_positions[end];
        let total_length = chain.lengths.iter().sum::<f64>().max(0.001);
        let maximum_residual = total_length * 0.18;
        let mut traversed = 0.0;
        for (offset, &particle) in chain.particles.iter().enumerate().skip(1) {
            traversed += chain.lengths[offset - 1];
            if particle == end {
                continue;
            }
            let ratio = traversed / total_length;
            let linear = GfaLayoutPoint {
                x: start_position.x + (end_position.x - start_position.x) * ratio,
                y: start_position.y + (end_position.y - start_position.y) * ratio,
            };
            let force_linear = GfaLayoutPoint {
                x: force_start.x + (force_end.x - force_start.x) * ratio,
                y: force_start.y + (force_end.y - force_start.y) * ratio,
            };
            let residual = GfaLayoutPoint {
                x: force_positions[particle].x - force_linear.x,
                y: force_positions[particle].y - force_linear.y,
            };
            let residual_length = residual.x.hypot(residual.y);
            let residual_scale = if residual_length > maximum_residual {
                maximum_residual / residual_length
            } else {
                1.0
            };
            positions[particle] = GfaLayoutPoint {
                x: linear.x + residual.x * residual_scale * CHAIN_CURVE_RETAIN_RATIO,
                y: linear.y + residual.y * residual_scale * CHAIN_CURVE_RETAIN_RATIO,
            };
        }
    }

    // Remove sharp particle corners while retaining the force-derived curve.
    // Endpoints stay shared with branches; only degree-two interiors move.
    for _ in 0..4 {
        let previous = positions.to_vec();
        for chain in chains {
            if chain.particles.len() < 3 || chain.particles.first() == chain.particles.last() {
                continue;
            }
            for index in 1..chain.particles.len() - 1 {
                let particle = chain.particles[index];
                let before = chain.particles[index - 1];
                let after = chain.particles[index + 1];
                let before_length = chain.lengths[index - 1];
                let after_length = chain.lengths[index];
                let ratio = before_length / (before_length + after_length).max(0.001);
                let smooth = GfaLayoutPoint {
                    x: previous[before].x + (previous[after].x - previous[before].x) * ratio,
                    y: previous[before].y + (previous[after].y - previous[before].y) * ratio,
                };
                positions[particle].x = previous[particle].x * 0.78 + smooth.x * 0.22;
                positions[particle].y = previous[particle].y * 0.78 + smooth.y * 0.22;
            }
        }
    }
}

fn add_multiscale_chain_chords(particles: &[usize], lengths: &[f64], output: &mut Vec<Spring>) {
    let segment_count = lengths.len();
    if segment_count < 3 {
        return;
    }
    for window in [4usize, 8, 16] {
        if window >= segment_count {
            continue;
        }
        let step = (window / 2).max(1);
        for start in (0..=segment_count - window).step_by(step) {
            output.push(Spring {
                source: particles[start],
                target: particles[start + window],
                length: lengths[start..start + window].iter().sum(),
                weight: LINEARITY_SPRING_WEIGHT,
            });
        }
    }
    output.push(Spring {
        source: particles[0],
        target: particles[segment_count],
        length: lengths.iter().sum(),
        weight: LINEARITY_SPRING_WEIGHT,
    });
}

fn ordered_particle_edge(left: usize, right: usize) -> (usize, usize) {
    if left < right {
        (left, right)
    } else {
        (right, left)
    }
}

fn add_particle_neighbor(neighbors: &mut Vec<(usize, f64)>, particle: usize, length: f64) {
    if let Some(existing) = neighbors.iter_mut().find(|neighbor| neighbor.0 == particle) {
        existing.1 = existing.1.min(length);
    } else {
        neighbors.push((particle, length));
        neighbors.sort_unstable_by_key(|neighbor| neighbor.0);
    }
}

fn physical_endpoint_particle(
    range: &std::ops::Range<usize>,
    reverse: bool,
    side: GfaLayoutSide,
) -> usize {
    let visual_start = range.start;
    let visual_end = range.end - 1;
    match (reverse, side) {
        (false, GfaLayoutSide::Start) | (true, GfaLayoutSide::End) => visual_start,
        (false, GfaLayoutSide::End) | (true, GfaLayoutSide::Start) => visual_end,
    }
}

fn build_levels(fine: LayoutLevel) -> Vec<LayoutLevel> {
    let mut levels = vec![fine];
    while levels.len() < MAX_LEVELS {
        let current = levels.last().expect("fine level exists");
        if current.masses.len() <= MIN_COARSE_VERTICES {
            break;
        }
        let (coarse, mapping) = coarsen_level(current);
        if coarse.masses.len() >= current.masses.len().saturating_sub(1) {
            break;
        }
        levels.last_mut().expect("fine level exists").fine_to_coarse = Some(mapping);
        levels.push(coarse);
    }
    levels
}

fn coarsen_level(level: &LayoutLevel) -> (LayoutLevel, Vec<usize>) {
    let mut neighbors = vec![Vec::<(usize, f64)>::new(); level.masses.len()];
    for spring in &level.springs {
        neighbors[spring.source].push((spring.target, spring.weight));
        neighbors[spring.target].push((spring.source, spring.weight));
    }
    for values in &mut neighbors {
        values.sort_by(|left, right| {
            right
                .1
                .total_cmp(&left.1)
                .then_with(|| left.0.cmp(&right.0))
        });
    }

    let mut mapping = vec![usize::MAX; level.masses.len()];
    let mut coarse_masses = Vec::new();
    for vertex in 0..level.masses.len() {
        if mapping[vertex] != usize::MAX {
            continue;
        }
        let partner = neighbors[vertex]
            .iter()
            .map(|(neighbor, _)| *neighbor)
            .find(|neighbor| mapping[*neighbor] == usize::MAX);
        let coarse_index = coarse_masses.len();
        mapping[vertex] = coarse_index;
        let mut mass = level.masses[vertex];
        if let Some(partner) = partner {
            mapping[partner] = coarse_index;
            mass += level.masses[partner];
        }
        coarse_masses.push(mass);
    }

    let mut combined = BTreeMap::<(usize, usize), (f64, f64)>::new();
    for spring in &level.springs {
        let source = mapping[spring.source];
        let target = mapping[spring.target];
        if source == target {
            continue;
        }
        let key = if source < target {
            (source, target)
        } else {
            (target, source)
        };
        let entry = combined.entry(key).or_insert((0.0, 0.0));
        entry.0 += spring.length * spring.weight;
        entry.1 += spring.weight;
    }
    let springs = combined
        .into_iter()
        .map(|((source, target), (weighted_length, weight))| Spring {
            source,
            target,
            length: (weighted_length / weight.max(0.001)).max(18.0),
            weight: weight.sqrt().clamp(0.5, 3.0),
        })
        .collect();
    (
        LayoutLevel {
            masses: coarse_masses,
            springs,
            fine_to_coarse: None,
        },
        mapping,
    )
}

fn solve_levels(
    levels: &[LayoutLevel],
    component: &[usize],
    nodes: &[GfaLayoutNode],
) -> Vec<GfaLayoutPoint> {
    let coarsest_index = levels.len() - 1;
    let coarsest = &levels[coarsest_index];
    let radius = (coarsest.masses.len() as f64).sqrt().max(1.0) * 34.0;
    let component_key = component
        .first()
        .map(|index| nodes[*index].id.as_str())
        .unwrap_or("component");
    let phase = deterministic_angle(component_key, 73);
    let mut positions = (0..coarsest.masses.len())
        .map(|index| {
            let angle =
                phase + std::f64::consts::TAU * index as f64 / coarsest.masses.len().max(1) as f64;
            GfaLayoutPoint {
                x: angle.cos() * radius,
                y: angle.sin() * radius,
            }
        })
        .collect::<Vec<_>>();
    relax_level(coarsest, &mut positions, 72);

    for level_index in (0..coarsest_index).rev() {
        let level = &levels[level_index];
        let mapping = level
            .fine_to_coarse
            .as_ref()
            .expect("every non-coarsest level maps to its parent");
        let parent_positions = positions;
        positions = mapping
            .iter()
            .enumerate()
            .map(|(index, parent)| {
                let angle = deterministic_angle(component_key, index as u64 + 101);
                let jitter = 5.0 + (index % 7) as f64;
                GfaLayoutPoint {
                    x: parent_positions[*parent].x + angle.cos() * jitter,
                    y: parent_positions[*parent].y + angle.sin() * jitter,
                }
            })
            .collect();
        let iterations = if level.masses.len() > 5_000 {
            22
        } else if level.masses.len() > 1_000 {
            30
        } else {
            46
        };
        relax_level(level, &mut positions, iterations);
    }
    positions
}

fn relax_level(level: &LayoutLevel, positions: &mut [GfaLayoutPoint], iterations: usize) {
    if positions.len() <= 1 {
        return;
    }
    for iteration in 0..iterations {
        let cooling = 1.0 - iteration as f64 / (iterations as f64 + 8.0);
        let mut movement = vec![GfaLayoutPoint::zero(); positions.len()];
        for spring in &level.springs {
            let dx = positions[spring.target].x - positions[spring.source].x;
            let dy = positions[spring.target].y - positions[spring.source].y;
            let distance = dx.hypot(dy).max(0.001);
            let force =
                ((distance - spring.length) * 0.075 * spring.weight * cooling).clamp(-8.0, 8.0);
            let source_share = level.masses[spring.target]
                / (level.masses[spring.source] + level.masses[spring.target]);
            let target_share = 1.0 - source_share;
            movement[spring.source].x += dx / distance * force * source_share;
            movement[spring.source].y += dy / distance * force * source_share;
            movement[spring.target].x -= dx / distance * force * target_share;
            movement[spring.target].y -= dy / distance * force * target_share;
        }

        let tree = QuadTree::build(positions, &level.masses);
        let repulsion_strength = 1_250.0 * cooling.max(0.25);
        for index in 0..positions.len() {
            let force = tree.repulsion_on(index, positions, &level.masses, repulsion_strength);
            movement[index].x += force.x / level.masses[index].max(1.0);
            movement[index].y += force.y / level.masses[index].max(1.0);
        }

        let center = weighted_center(positions, &level.masses);
        let max_step = 2.0 + 9.0 * cooling;
        for index in 0..positions.len() {
            movement[index].x += (center.x - positions[index].x) * 0.004;
            movement[index].y += (center.y - positions[index].y) * 0.004;
            let magnitude = movement[index].x.hypot(movement[index].y);
            let scale = if magnitude > max_step {
                max_step / magnitude
            } else {
                1.0
            };
            positions[index].x += movement[index].x * scale;
            positions[index].y += movement[index].y * scale;
        }
        recenter(positions, &level.masses);
    }
}

#[derive(Debug)]
struct QuadTree {
    root: QuadCell,
}

#[derive(Debug)]
struct QuadCell {
    center_x: f64,
    center_y: f64,
    half_size: f64,
    mass: f64,
    mass_x: f64,
    mass_y: f64,
    points: Vec<usize>,
    children: Vec<QuadCell>,
}

impl QuadTree {
    fn build(positions: &[GfaLayoutPoint], masses: &[f64]) -> Self {
        let min_x = positions
            .iter()
            .map(|point| point.x)
            .fold(f64::INFINITY, f64::min);
        let max_x = positions
            .iter()
            .map(|point| point.x)
            .fold(f64::NEG_INFINITY, f64::max);
        let min_y = positions
            .iter()
            .map(|point| point.y)
            .fold(f64::INFINITY, f64::min);
        let max_y = positions
            .iter()
            .map(|point| point.y)
            .fold(f64::NEG_INFINITY, f64::max);
        let half_size = ((max_x - min_x).max(max_y - min_y) / 2.0 + 1.0).max(1.0);
        let root = QuadCell::build(
            (min_x + max_x) / 2.0,
            (min_y + max_y) / 2.0,
            half_size,
            (0..positions.len()).collect(),
            positions,
            masses,
            0,
        );
        Self { root }
    }

    fn repulsion_on(
        &self,
        target: usize,
        positions: &[GfaLayoutPoint],
        masses: &[f64],
        strength: f64,
    ) -> GfaLayoutPoint {
        self.root.repulsion_on(target, positions, masses, strength)
    }
}

impl QuadCell {
    #[allow(clippy::too_many_arguments)]
    fn build(
        center_x: f64,
        center_y: f64,
        half_size: f64,
        points: Vec<usize>,
        positions: &[GfaLayoutPoint],
        masses: &[f64],
        depth: usize,
    ) -> Self {
        let mass = points.iter().map(|index| masses[*index]).sum::<f64>();
        let mass_x = points
            .iter()
            .map(|index| positions[*index].x * masses[*index])
            .sum::<f64>();
        let mass_y = points
            .iter()
            .map(|index| positions[*index].y * masses[*index])
            .sum::<f64>();
        if points.len() <= 2 || depth >= 18 || half_size < 0.001 {
            return Self {
                center_x,
                center_y,
                half_size,
                mass,
                mass_x,
                mass_y,
                points,
                children: Vec::new(),
            };
        }
        let mut quadrants = [Vec::new(), Vec::new(), Vec::new(), Vec::new()];
        for &index in &points {
            let right = usize::from(positions[index].x >= center_x);
            let bottom = usize::from(positions[index].y >= center_y);
            quadrants[bottom * 2 + right].push(index);
        }
        let child_half = half_size / 2.0;
        let mut children = Vec::new();
        for (quadrant, values) in quadrants.into_iter().enumerate() {
            if values.is_empty() {
                continue;
            }
            let child_x = center_x
                + if quadrant % 2 == 0 {
                    -child_half
                } else {
                    child_half
                };
            let child_y = center_y
                + if quadrant < 2 {
                    -child_half
                } else {
                    child_half
                };
            children.push(Self::build(
                child_x,
                child_y,
                child_half,
                values,
                positions,
                masses,
                depth + 1,
            ));
        }
        Self {
            center_x,
            center_y,
            half_size,
            mass,
            mass_x,
            mass_y,
            points: Vec::new(),
            children,
        }
    }

    fn repulsion_on(
        &self,
        target: usize,
        positions: &[GfaLayoutPoint],
        masses: &[f64],
        strength: f64,
    ) -> GfaLayoutPoint {
        if self.mass <= 0.0 {
            return GfaLayoutPoint::zero();
        }
        if self.children.is_empty() {
            let mut force = GfaLayoutPoint::zero();
            for &other in &self.points {
                if other == target {
                    continue;
                }
                add_pair_repulsion(
                    &mut force,
                    positions[target],
                    positions[other],
                    masses[target],
                    masses[other],
                    strength,
                );
            }
            return force;
        }
        let target_point = positions[target];
        let contains_target = target_point.x >= self.center_x - self.half_size
            && target_point.x <= self.center_x + self.half_size
            && target_point.y >= self.center_y - self.half_size
            && target_point.y <= self.center_y + self.half_size;
        let center_of_mass = GfaLayoutPoint {
            x: self.mass_x / self.mass,
            y: self.mass_y / self.mass,
        };
        let distance = (target_point.x - center_of_mass.x)
            .hypot(target_point.y - center_of_mass.y)
            .max(0.001);
        if !contains_target && self.half_size * 2.0 / distance < 0.72 {
            let mut force = GfaLayoutPoint::zero();
            add_pair_repulsion(
                &mut force,
                target_point,
                center_of_mass,
                masses[target],
                self.mass,
                strength,
            );
            return force;
        }
        self.children
            .iter()
            .fold(GfaLayoutPoint::zero(), |mut sum, child| {
                let force = child.repulsion_on(target, positions, masses, strength);
                sum.x += force.x;
                sum.y += force.y;
                sum
            })
    }
}

fn add_pair_repulsion(
    force: &mut GfaLayoutPoint,
    target: GfaLayoutPoint,
    other: GfaLayoutPoint,
    target_mass: f64,
    other_mass: f64,
    strength: f64,
) {
    let dx = target.x - other.x;
    let dy = target.y - other.y;
    let distance = dx.hypot(dy).max(1.0);
    let magnitude = strength * target_mass * other_mass / (distance * distance + 36.0);
    force.x += dx / distance * magnitude;
    force.y += dy / distance * magnitude;
}

fn weighted_center(points: &[GfaLayoutPoint], masses: &[f64]) -> GfaLayoutPoint {
    let total = masses.iter().sum::<f64>().max(0.001);
    GfaLayoutPoint {
        x: points
            .iter()
            .zip(masses)
            .map(|(point, mass)| point.x * mass)
            .sum::<f64>()
            / total,
        y: points
            .iter()
            .zip(masses)
            .map(|(point, mass)| point.y * mass)
            .sum::<f64>()
            / total,
    }
}

fn recenter(points: &mut [GfaLayoutPoint], masses: &[f64]) {
    let center = weighted_center(points, masses);
    for point in points {
        point.x -= center.x;
        point.y -= center.y;
    }
}

fn rotate_component_horizontally(paths: &mut [Vec<GfaLayoutPoint>]) {
    let points = paths.iter().flatten().copied().collect::<Vec<_>>();
    if points.len() < 2 {
        return;
    }
    let center = GfaLayoutPoint {
        x: points.iter().map(|point| point.x).sum::<f64>() / points.len() as f64,
        y: points.iter().map(|point| point.y).sum::<f64>() / points.len() as f64,
    };
    let xx = points
        .iter()
        .map(|point| (point.x - center.x).powi(2))
        .sum::<f64>();
    let yy = points
        .iter()
        .map(|point| (point.y - center.y).powi(2))
        .sum::<f64>();
    let xy = points
        .iter()
        .map(|point| (point.x - center.x) * (point.y - center.y))
        .sum::<f64>();
    let angle = 0.5 * (2.0 * xy).atan2(xx - yy);
    let cosine = angle.cos();
    let sine = angle.sin();
    for point in paths.iter_mut().flatten() {
        let x = point.x - center.x;
        let y = point.y - center.y;
        point.x = x * cosine + y * sine;
        point.y = -x * sine + y * cosine;
    }
}

fn pack_components(layouts: &mut [ComponentLayout], total_nodes: usize) {
    let target_row_width = 900.0_f64.max((total_nodes as f64).sqrt() * 110.0);
    let mut shelf_x = 60.0;
    let mut shelf_y = 60.0;
    let mut row_height: f64 = 0.0;
    for layout in layouts {
        let bounds = component_bounds(&layout.paths);
        let width = (bounds.2 - bounds.0 + 70.0).max(48.0);
        let height = (bounds.3 - bounds.1 + 58.0).max(36.0);
        if shelf_x > 60.0 && shelf_x + width > target_row_width {
            shelf_x = 60.0;
            shelf_y += row_height + 48.0;
            row_height = 0.0;
        }
        let translate_x = shelf_x - bounds.0 + 35.0;
        let translate_y = shelf_y - bounds.1 + 29.0;
        for point in layout.paths.iter_mut().flatten() {
            point.x += translate_x;
            point.y += translate_y;
        }
        shelf_x += width + 44.0;
        row_height = row_height.max(height);
    }
}

fn component_bounds(paths: &[Vec<GfaLayoutPoint>]) -> (f64, f64, f64, f64) {
    paths.iter().flatten().fold(
        (
            f64::INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::NEG_INFINITY,
        ),
        |bounds, point| {
            (
                bounds.0.min(point.x),
                bounds.1.min(point.y),
                bounds.2.max(point.x),
                bounds.3.max(point.y),
            )
        },
    )
}

fn safe_width(width: f64) -> f64 {
    if width.is_finite() {
        width.clamp(8.0, 2_048.0)
    } else {
        18.0
    }
}

fn control_point_count(width: f64) -> usize {
    ((safe_width(width) / PATH_SEGMENT_LENGTH).ceil() as usize + 1).max(2)
}

fn deterministic_angle(value: &str, salt: u64) -> f64 {
    let mut hash = 1_469_598_103_934_665_603_u64 ^ salt;
    for byte in value.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(1_099_511_628_211);
    }
    let fraction = (hash % 1_000_003) as f64 / 1_000_003.0;
    fraction * std::f64::consts::TAU
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(id: &str, width: f64) -> GfaLayoutNode {
        GfaLayoutNode {
            id: id.to_string(),
            width,
            reverse: false,
            layout_unit_id: id.to_string(),
            layout_order: 0,
        }
    }

    #[test]
    fn layout_is_deterministic_and_finite() {
        let nodes = vec![node("a", 96.0), node("b", 144.0), node("c", 48.0)];
        let edges = vec![
            GfaLayoutEdge {
                source: "a".to_string(),
                target: "b".to_string(),
                source_side: GfaLayoutSide::End,
                target_side: GfaLayoutSide::Start,
            },
            GfaLayoutEdge {
                source: "b".to_string(),
                target: "c".to_string(),
                source_side: GfaLayoutSide::End,
                target_side: GfaLayoutSide::Start,
            },
        ];
        let first = layout_gfa_multilevel(&nodes, &edges);
        let second = layout_gfa_multilevel(&nodes, &edges);

        assert_eq!(first, second);
        assert!(first
            .iter()
            .flat_map(|path| &path.points)
            .all(|point| point.x.is_finite() && point.y.is_finite()));
    }

    #[test]
    fn control_point_count_tracks_drawn_length() {
        let paths = layout_gfa_multilevel(
            &[
                node("short", 18.0),
                node("medium", 180.0),
                node("long", 360.0),
            ],
            &[],
        );

        assert!(paths[0].points.len() < paths[1].points.len());
        assert!(paths[1].points.len() < paths[2].points.len());
    }

    #[test]
    fn linked_physical_endpoints_are_closer_than_opposite_ends() {
        let paths = layout_gfa_multilevel(
            &[node("a", 120.0), node("b", 120.0)],
            &[GfaLayoutEdge {
                source: "a".to_string(),
                target: "b".to_string(),
                source_side: GfaLayoutSide::End,
                target_side: GfaLayoutSide::Start,
            }],
        );
        let a = &paths[0].points;
        let b = &paths[1].points;
        let linked = distance(a[a.len() - 1], b[0]);
        let opposite = distance(a[0], b[b.len() - 1]);

        assert!(linked < opposite, "linked={linked}, opposite={opposite}");
    }

    #[test]
    fn reverse_orientation_maps_physical_side_to_visual_endpoint() {
        let mut reversed = node("a", 120.0);
        reversed.reverse = true;
        let paths = layout_gfa_multilevel(
            &[reversed, node("b", 120.0)],
            &[GfaLayoutEdge {
                source: "a".to_string(),
                target: "b".to_string(),
                source_side: GfaLayoutSide::End,
                target_side: GfaLayoutSide::Start,
            }],
        );
        let a = &paths[0].points;
        let b = &paths[1].points;

        assert!(distance(a[0], b[0]) < distance(a[a.len() - 1], b[b.len() - 1]));
    }

    #[test]
    fn invalid_edges_do_not_remove_nodes() {
        let paths = layout_gfa_multilevel(
            &[node("a", 80.0), node("b", 80.0)],
            &[GfaLayoutEdge {
                source: "missing".to_string(),
                target: "b".to_string(),
                source_side: GfaLayoutSide::End,
                target_side: GfaLayoutSide::Start,
            }],
        );

        assert_eq!(paths.len(), 2);
        assert!(paths.iter().all(|path| path.points.len() >= 2));
    }

    #[test]
    fn block_members_layout_as_one_continuous_unitig() {
        let mut first = node("a", 96.0);
        first.layout_unit_id = "Chr01g1/block-1".to_string();
        first.layout_order = 0;
        let mut second = node("b", 144.0);
        second.layout_unit_id = "Chr01g1/block-1".to_string();
        second.layout_order = 1;
        let nodes = vec![first, second];

        let without_internal_link = layout_gfa_multilevel(&nodes, &[]);
        let with_internal_link = layout_gfa_multilevel(
            &nodes,
            &[GfaLayoutEdge {
                source: "a".to_string(),
                target: "b".to_string(),
                source_side: GfaLayoutSide::End,
                target_side: GfaLayoutSide::Start,
            }],
        );

        assert_eq!(without_internal_link, with_internal_link);
        let first_end = *without_internal_link[0].points.last().unwrap();
        let second_start = without_internal_link[1].points[0];
        let block_gap = distance(first_end, second_start);
        assert!(block_gap < 0.001, "block_gap={block_gap}");
    }

    #[test]
    fn medium_branched_graph_keeps_every_path_and_control_point_finite() {
        let node_count = 180usize;
        let nodes = (0..node_count)
            .map(|index| node(&format!("node-{index}"), 48.0 + (index % 7) as f64 * 36.0))
            .collect::<Vec<_>>();
        let mut edges = (0..node_count - 1)
            .map(|index| GfaLayoutEdge {
                source: format!("node-{index}"),
                target: format!("node-{}", index + 1),
                source_side: GfaLayoutSide::End,
                target_side: GfaLayoutSide::Start,
            })
            .collect::<Vec<_>>();
        edges.extend((0..node_count - 17).step_by(3).map(|index| GfaLayoutEdge {
            source: format!("node-{index}"),
            target: format!("node-{}", index + 17),
            source_side: GfaLayoutSide::End,
            target_side: GfaLayoutSide::Start,
        }));

        let paths = layout_gfa_multilevel(&nodes, &edges);

        assert_eq!(paths.len(), node_count);
        for (index, path) in paths.iter().enumerate() {
            assert_eq!(path.id, format!("node-{index}"));
            assert!(path.points.len() >= 2);
            assert!(path
                .points
                .iter()
                .all(|point| point.x.is_finite() && point.y.is_finite()));
        }
    }

    #[test]
    fn non_branching_graph_prefers_a_linear_but_deformable_spine() {
        let node_count = 12usize;
        let nodes = (0..node_count)
            .map(|index| node(&format!("chain-{index}"), 96.0))
            .collect::<Vec<_>>();
        let edges = (0..node_count - 1)
            .map(|index| GfaLayoutEdge {
                source: format!("chain-{index}"),
                target: format!("chain-{}", index + 1),
                source_side: GfaLayoutSide::End,
                target_side: GfaLayoutSide::Start,
            })
            .collect::<Vec<_>>();

        let paths = layout_gfa_multilevel(&nodes, &edges);
        let centers = paths
            .iter()
            .map(|path| {
                let count = path.points.len() as f64;
                GfaLayoutPoint {
                    x: path.points.iter().map(|point| point.x).sum::<f64>() / count,
                    y: path.points.iter().map(|point| point.y).sum::<f64>() / count,
                }
            })
            .collect::<Vec<_>>();
        let span = centers
            .iter()
            .map(|point| point.x)
            .fold(f64::NEG_INFINITY, f64::max)
            - centers
                .iter()
                .map(|point| point.x)
                .fold(f64::INFINITY, f64::min);
        let vertical_spread = centers
            .iter()
            .map(|point| point.y)
            .fold(f64::NEG_INFINITY, f64::max)
            - centers
                .iter()
                .map(|point| point.y)
                .fold(f64::INFINITY, f64::min);

        assert!(
            vertical_spread / span.max(1.0) < 0.12,
            "vertical_spread={vertical_spread}, span={span}"
        );
        let maximum_bend = paths
            .iter()
            .map(|path| path_bend(&path.points))
            .fold(0.0, f64::max);
        assert!(maximum_bend > 2.0, "maximum_bend={maximum_bend}");
    }

    #[test]
    fn isolated_long_unitig_keeps_a_curved_control_path() {
        let paths = layout_gfa_multilevel(&[node("curved", 360.0)], &[]);

        assert_eq!(paths.len(), 1);
        assert!(path_bend(&paths[0].points) > 20.0);
    }

    fn distance(left: GfaLayoutPoint, right: GfaLayoutPoint) -> f64 {
        (left.x - right.x).hypot(left.y - right.y)
    }

    fn path_bend(points: &[GfaLayoutPoint]) -> f64 {
        let Some((&start, rest)) = points.split_first() else {
            return 0.0;
        };
        let Some(&end) = rest.last() else {
            return 0.0;
        };
        let dx = end.x - start.x;
        let dy = end.y - start.y;
        let length = dx.hypot(dy).max(0.001);
        points
            .iter()
            .map(|point| ((point.x - start.x) * dy - (point.y - start.y) * dx).abs() / length)
            .fold(0.0, f64::max)
    }
}
