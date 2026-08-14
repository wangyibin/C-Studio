export const defaultGfaHomologPattern = "(Chr\\d+)g(\\d+)";

export interface GfaHomologScaffold {
  id: string;
  member: string;
}

export interface GfaHomologColumn {
  id: string;
  scaffolds: GfaHomologScaffold[];
}

export interface GfaHomologClassification {
  columns: GfaHomologColumn[];
  otherScaffolds: string[];
  error: string | null;
}

export interface GfaHomologLayoutNode {
  id: string;
  groupId: string;
  assemblyBlockId?: string | null;
  order: number;
  length?: number;
}

export interface GfaCurationLayoutEdge {
  source: string;
  target: string;
  kind: "agp-joined" | "agp-gap" | "gfa-link";
}

export type GfaLinkScope = "within-scaffold" | "homolog" | "non-homolog";
export type GfaLayoutMode = "curation" | "guided" | "bandage";

const bandageMinimumNodeWidth = 18;
const bandageMaximumNodeWidth = 360;
const curationMinimumNodeWidth = 12;
const curationMaximumNodeWidth = 180;
const curationDisconnectedFromChromosomesGap = 1_100;
const curationDisconnectedFromEvidenceGap = 640;
const curationDisconnectedChromosomeSpanRatio = 0.22;
const curationDisconnectedEvidenceSpanRatio = 0.12;

/**
 * Convert sequence length to a linear Bandage-style node width. The automatic
 * bp/px scale maps the 90th percentile to 180 px, so a few giant unitigs do not
 * collapse every other contig. Width ratios remain linear until the readable
 * minimum or safety maximum is reached.
 */
export function gfaBandageNodeWidths(nodes: GfaHomologLayoutNode[]) {
  const lengths = nodes
    .map((node) => Math.max(1, finiteLength(node.length)))
    .sort((left, right) => left - right);
  if (lengths.length === 0) {
    return new Map<string, number>();
  }
  const referenceIndex = Math.min(
    lengths.length - 1,
    Math.floor((lengths.length - 1) * 0.9),
  );
  const bpPerPixel = Math.max(1, lengths[referenceIndex] / 180);
  return new Map(nodes.map((node) => [
    node.id,
    clampNumber(
      Math.max(1, finiteLength(node.length)) / bpPerPixel,
      bandageMinimumNodeWidth,
      bandageMaximumNodeWidth,
    ),
  ]));
}

/**
 * Compact length scale for chromosome rows. Square-root compression preserves
 * useful length differences without allowing a few giant unitigs to dominate
 * the entire curation canvas.
 */
export function gfaCurationNodeWidths(nodes: GfaHomologLayoutNode[]) {
  const transformedLengths = nodes
    .map((node) => Math.sqrt(Math.max(1, finiteLength(node.length))))
    .sort((left, right) => left - right);
  if (transformedLengths.length === 0) {
    return new Map<string, number>();
  }
  const referenceIndex = Math.min(
    transformedLengths.length - 1,
    Math.floor((transformedLengths.length - 1) * 0.9),
  );
  const transformedBpPerPixel = Math.max(1, transformedLengths[referenceIndex] / 84);
  return new Map(nodes.map((node) => [
    node.id,
    clampNumber(
      Math.sqrt(Math.max(1, finiteLength(node.length))) / transformedBpPerPixel,
      curationMinimumNodeWidth,
      curationMaximumNodeWidth,
    ),
  ]));
}

export interface GfaGraphPoint {
  x: number;
  y: number;
}

/**
 * Keep chromosome labels legible as ploidy grows. Tetraploid and smaller
 * groups retain the compact layout; higher-ploidy groups gain progressively
 * more lane separation, capped so a single group remains practical to pan.
 */
export function gfaHomologRowGap(memberCount: number) {
  const safeMemberCount = Number.isFinite(memberCount)
    ? Math.max(1, Math.floor(memberCount))
    : 1;
  return clampNumber(44 + Math.max(0, safeMemberCount - 4) * 5, 44, 96);
}

export function classifyGfaScaffolds(
  scaffoldIds: string[],
  patternSource = defaultGfaHomologPattern,
): GfaHomologClassification {
  let pattern: RegExp;
  try {
    pattern = new RegExp(patternSource);
  } catch (error) {
    return {
      columns: [],
      otherScaffolds: [...scaffoldIds],
      error: `Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const columns = new Map<string, GfaHomologScaffold[]>();
  const otherScaffolds: string[] = [];
  for (const scaffoldId of scaffoldIds) {
    if (scaffoldId === "Unplaced") {
      otherScaffolds.push(scaffoldId);
      continue;
    }
    const match = pattern.exec(scaffoldId);
    if (!match?.[1] || !match[2]) {
      otherScaffolds.push(scaffoldId);
      continue;
    }
    const scaffolds = columns.get(match[1]) ?? [];
    scaffolds.push({ id: scaffoldId, member: match[2] });
    columns.set(match[1], scaffolds);
  }

  return {
    columns: [...columns.entries()]
      .sort(([left], [right]) => naturalCompare(left, right))
      .map(([id, scaffolds]) => ({
        id,
        scaffolds: scaffolds.sort((left, right) => (
          naturalCompare(left.member, right.member) || naturalCompare(left.id, right.id)
        )),
      })),
    otherScaffolds: otherScaffolds.sort(naturalCompare),
    error: null,
  };
}

export function layoutGfaNodesByHomolog(
  nodes: GfaHomologLayoutNode[],
  homologs: GfaHomologClassification,
) {
  const groups = new Map<string, GfaHomologLayoutNode[]>();
  for (const node of nodes) {
    const values = groups.get(node.groupId) ?? [];
    values.push(node);
    groups.set(node.groupId, values);
  }
  for (const values of groups.values()) {
    // AGP visual order is authoritative. Orientation is rendered by the node
    // arrow itself; it must not reverse the order of placements in a block.
    values.sort((left, right) => (
      left.order - right.order || naturalCompare(left.id, right.id)
    ));
  }

  const positions = new Map<string, GfaGraphPoint>();
  const widths = gfaCurationNodeWidths(nodes);
  const chromosomeStartX = 170;
  const firstRowY = 72;
  const minimumNonHomologGroupGap = 112;
  const joinedSpacing = 4;
  const blockSpacing = 30;
  let nextRowY = firstRowY;

  function placeChromosomeRow(scaffoldId: string, y: number) {
    let previous: GfaHomologLayoutNode | undefined;
    let rightEdge = chromosomeStartX;
    for (const node of groups.get(scaffoldId) ?? []) {
      const width = widths.get(node.id) ?? curationMinimumNodeWidth;
      const spacing = previous
        ? assemblyBlockKey(previous) === assemblyBlockKey(node) ? joinedSpacing : blockSpacing
        : 0;
      const x = rightEdge + spacing + width / 2;
      positions.set(node.id, { x, y });
      rightEdge = x + width / 2;
      previous = node;
    }
  }

  for (const column of homologs.columns) {
    const homologRowGap = gfaHomologRowGap(column.scaffolds.length);
    for (const scaffold of column.scaffolds) {
      placeChromosomeRow(scaffold.id, nextRowY);
      nextRowY += homologRowGap;
    }
    // Preserve the stronger visual break between different chromosome groups
    // even when a high-ploidy group needs wider internal lanes.
    nextRowY += Math.max(minimumNonHomologGroupGap, homologRowGap * 1.5);
  }

  return positions;
}

/**
 * Produce a deterministic, evidence-aware layout for assembly curation.
 *
 * Bandage uses an unconstrained multilevel force-directed layout. That is useful
 * for discovering graph shape, but it can move a placed unitig far away from its
 * chromosome context. Here AGP order and homolog lanes are anchors, while GFA
 * unanchored components are arranged from graph topology without moving the
 * chromosome rows. The result is computed once and frozen; it is not a live
 * spring simulation.
 */
export function layoutGfaNodesForCuration(
  nodes: GfaHomologLayoutNode[],
  edges: GfaCurationLayoutEdge[],
  homologs: GfaHomologClassification,
  evidenceNodes: GfaHomologLayoutNode[] = nodes,
  evidenceEdges: GfaCurationLayoutEdge[] = edges,
) {
  const basePositions = layoutGfaNodesByHomolog(nodes, homologs);
  const positions = new Map(basePositions);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const evidenceById = new Map(evidenceNodes.map((node) => [node.id, node]));
  const homologByScaffold = new Map(
    homologs.columns.flatMap((column) => (
      column.scaffolds.map((scaffold) => [scaffold.id, column.id] as const)
    )),
  );
  // Regex membership, not AGP presence, defines chromosome anchoring. AGP
  // singleton objects that do not match are handled like GFA-only unanchors.
  const unplacedNodes = nodes.filter((node) => !homologByScaffold.has(node.groupId));
  if (unplacedNodes.length === 0) {
    return positions;
  }
  const unplacedIds = new Set(unplacedNodes.map((node) => node.id));
  const adjacency = new Map(unplacedNodes.map((node) => [node.id, [] as string[]]));
  for (const edge of edges) {
    if (edge.kind !== "gfa-link") {
      continue;
    }
    if (unplacedIds.has(edge.source) && unplacedIds.has(edge.target)) {
      adjacency.get(edge.source)!.push(edge.target);
      adjacency.get(edge.target)!.push(edge.source);
    }
  }

  const components: string[][] = [];
  const visited = new Set<string>();
  for (const node of unplacedNodes) {
    if (visited.has(node.id)) {
      continue;
    }
    const component: string[] = [];
    const queue = [node.id];
    visited.add(node.id);
    while (queue.length > 0) {
      const current = queue.shift()!;
      component.push(current);
      for (const neighbor of adjacency.get(current) ?? []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
    components.push(component);
  }

  const buckets = new Map<string, GfaHomologLayoutNode[]>();
  for (const component of components) {
    const componentIds = new Set(component);
    const linkedGroups = new Set<string>();
    for (const edge of evidenceEdges) {
      if (edge.kind !== "gfa-link") {
        continue;
      }
      const otherId = componentIds.has(edge.source)
        ? edge.target
        : componentIds.has(edge.target) ? edge.source : null;
      if (!otherId || componentIds.has(otherId)) {
        continue;
      }
      const placed = evidenceById.get(otherId);
      if (!placed || !homologByScaffold.has(placed.groupId)) {
        continue;
      }
      linkedGroups.add(homologByScaffold.get(placed.groupId)!);
    }
    // Only an unambiguous component belongs next to a homolog group. A
    // majority vote would visually overstate evidence for components that also
    // bridge another chromosome group.
    const target = linkedGroups.size === 1
      ? `__group:${[...linkedGroups][0]}`
      : linkedGroups.size > 1 ? "__cross-group" : "__disconnected";
    const values = buckets.get(target) ?? [];
    values.push(...component.map((id) => byId.get(id)!));
    buckets.set(target, values);
  }

  const placedNodes = nodes.filter((node) => homologByScaffold.has(node.groupId));
  const curationWidths = gfaCurationNodeWidths(nodes);
  const placedRight = Math.max(170, ...placedNodes.map((node) => {
    const point = basePositions.get(node.id);
    return point ? point.x + (curationWidths.get(node.id) ?? curationMinimumNodeWidth) / 2 : 170;
  }));
  const placedLeft = Math.min(170, ...placedNodes.map((node) => {
    const point = basePositions.get(node.id);
    return point ? point.x - (curationWidths.get(node.id) ?? curationMinimumNodeWidth) / 2 : 170;
  }));
  const placedSpan = Math.max(1, placedRight - placedLeft);
  const allPlacedY = placedNodes
    .map((node) => basePositions.get(node.id)?.y)
    .filter((value): value is number => value !== undefined);
  const fallbackY = allPlacedY.length > 0
    ? (Math.min(...allPlacedY) + Math.max(...allPlacedY)) / 2
    : 72;
  const targetY = new Map<string, number>();
  const targetRight = new Map<string, number>();
  for (const column of homologs.columns) {
    const scaffoldIds = new Set(column.scaffolds.map((scaffold) => scaffold.id));
    const values = placedNodes
      .filter((node) => scaffoldIds.has(node.groupId))
      .map((node) => basePositions.get(node.id)?.y)
      .filter((value): value is number => value !== undefined);
    if (values.length > 0) {
      targetY.set(column.id, values.reduce((sum, value) => sum + value, 0) / values.length);
    }
    const rights = placedNodes
      .filter((node) => scaffoldIds.has(node.groupId))
      .map((node) => {
        const point = basePositions.get(node.id);
        return point
          ? point.x + (curationWidths.get(node.id) ?? curationMinimumNodeWidth) / 2
          : undefined;
      })
      .filter((value): value is number => value !== undefined);
    if (rights.length > 0) {
      targetRight.set(column.id, Math.max(...rights));
    }
  }
  const chromosomeGroupOrder = homologs.columns.map((column) => column.id);
  function placeBucket(
    key: string,
    bucketStartX: number,
    bucketTargetY: number,
  ) {
    const bucketNodes = buckets.get(key) ?? [];
    if (bucketNodes.length === 0) {
      return bucketStartX;
    }
    const bucketIds = new Set(bucketNodes.map((node) => node.id));
    const bucketEdges = edges.filter((edge) => (
      edge.kind === "gfa-link" && bucketIds.has(edge.source) && bucketIds.has(edge.target)
    ));
    const local = layoutGfaNodesBandage(bucketNodes, bucketEdges);
    const localValues = [...local.values()];
    const minX = Math.min(...localValues.map((point) => point.x));
    const maxX = Math.max(...localValues.map((point) => point.x));
    const minY = Math.min(...localValues.map((point) => point.y));
    const maxY = Math.max(...localValues.map((point) => point.y));
    const centerY = (minY + maxY) / 2;
    for (const node of bucketNodes) {
      const point = local.get(node.id)!;
      positions.set(node.id, {
        x: bucketStartX + point.x - minX,
        y: bucketTargetY + point.y - centerY,
      });
    }
    return bucketStartX + Math.max(80, maxX - minX);
  }

  // Components linked exclusively to one homolog group sit near that group's
  // own right edge, rather than being serialized after the longest chromosome.
  for (const groupId of chromosomeGroupOrder) {
    placeBucket(
      `__group:${groupId}`,
      (targetRight.get(groupId) ?? placedRight) + 72,
      targetY.get(groupId) ?? fallbackY,
    );
  }

  // Ambiguous components retain a neutral unanchored position. Completely
  // disconnected components are pushed into a separate, more distant zone.
  const crossGroupEnd = placeBucket("__cross-group", placedRight + 220, fallbackY);
  const disconnectedStartX = Math.max(
    placedRight + Math.max(
      curationDisconnectedFromChromosomesGap,
      placedSpan * curationDisconnectedChromosomeSpanRatio,
    ),
    crossGroupEnd + Math.max(
      curationDisconnectedFromEvidenceGap,
      placedSpan * curationDisconnectedEvidenceSpanRatio,
    ),
  );
  placeBucket("__disconnected", disconnectedStartX, fallbackY);

  return positions;
}

/**
 * Deterministic topology layout inspired by Bandage's force-directed view.
 * Chromosome and homolog coordinates are ignored, but an AGP assembly block is
 * a rigid editing unit: its unitigs keep AGP order and compact spacing while the
 * whole block participates in the topology solve. The force pass runs once;
 * interaction never continues the simulation.
 */
export function layoutGfaNodesBandage(
  nodes: GfaHomologLayoutNode[],
  edges: GfaCurationLayoutEdge[],
) {
  if (nodes.length === 0) {
    return new Map<string, GfaGraphPoint>();
  }
  const nodeWidths = gfaBandageNodeWidths(nodes);
  const unitsByKey = new Map<string, {
    id: string;
    memberIndices: number[];
    width: number;
    firstOrder: number;
  }>();
  for (const [index, node] of nodes.entries()) {
    const key = rigidAssemblyBlockKey(node);
    const unit = unitsByKey.get(key) ?? {
      id: key,
      memberIndices: [],
      width: 0,
      firstOrder: node.order,
    };
    unit.memberIndices.push(index);
    unit.firstOrder = Math.min(unit.firstOrder, node.order);
    unitsByKey.set(key, unit);
  }
  const units = [...unitsByKey.values()]
    .sort((left, right) => left.firstOrder - right.firstOrder || naturalCompare(left.id, right.id));
  for (const unit of units) {
    unit.memberIndices.sort((left, right) => (
      nodes[left].order - nodes[right].order || naturalCompare(nodes[left].id, nodes[right].id)
    ));
    unit.width = unit.memberIndices.reduce((total, index) => (
      total + (nodeWidths.get(nodes[index].id) ?? bandageMinimumNodeWidth)
    ), 0) + Math.max(0, unit.memberIndices.length - 1) * 4;
  }

  const unitIndexByNodeId = new Map<string, number>();
  for (const [unitIndex, unit] of units.entries()) {
    for (const memberIndex of unit.memberIndices) {
      unitIndexByNodeId.set(nodes[memberIndex].id, unitIndex);
    }
  }
  const adjacency = units.map(() => [] as number[]);
  const usableEdges = edges.flatMap((edge) => {
    const source = unitIndexByNodeId.get(edge.source);
    const target = unitIndexByNodeId.get(edge.target);
    if (source === undefined || target === undefined || source === target) {
      return [];
    }
    adjacency[source].push(target);
    adjacency[target].push(source);
    return [{ source, target, kind: edge.kind }];
  });

  const components: number[][] = [];
  const visited = new Set<number>();
  for (let start = 0; start < units.length; start += 1) {
    if (visited.has(start)) {
      continue;
    }
    const component: number[] = [];
    const queue = [start];
    visited.add(start);
    while (queue.length > 0) {
      const current = queue.shift()!;
      component.push(current);
      for (const neighbor of adjacency[current]) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
    components.push(component);
  }
  components.sort((left, right) => right.length - left.length || left[0] - right[0]);

  const points = units.map((unit, index) => {
    const angle = deterministicAngle(unit.id, index);
    return { x: Math.cos(angle) * 80, y: Math.sin(angle) * 80 };
  });
  for (const component of components) {
    const root = [...component].sort((left, right) => (
      adjacency[right].length - adjacency[left].length || left - right
    ))[0];
    const levels = new Map<number, number>([[root, 0]]);
    const levelQueue = [root];
    while (levelQueue.length > 0) {
      const current = levelQueue.shift()!;
      for (const neighbor of adjacency[current]) {
        if (!levels.has(neighbor)) {
          levels.set(neighbor, (levels.get(current) ?? 0) + 1);
          levelQueue.push(neighbor);
        }
      }
    }
    const byLevel = new Map<number, number[]>();
    for (const index of component) {
      const level = levels.get(index) ?? 0;
      const values = byLevel.get(level) ?? [];
      values.push(index);
      byLevel.set(level, values);
    }
    for (const [level, values] of byLevel) {
      values.sort((left, right) => units[left].id.localeCompare(units[right].id));
      for (const [rank, index] of values.entries()) {
        points[index] = {
          x: level * 72 + deterministicNudge(units[index].id, 5),
          y: (rank - (values.length - 1) / 2) * 32 + deterministicNudge(units[index].id, 11),
        };
      }
    }
  }

  for (let iteration = 0; iteration < 72; iteration += 1) {
    const movement = points.map(() => ({ x: 0, y: 0 }));
    const cooling = 1 - iteration / 88;
    for (const edge of usableEdges) {
      const source = points[edge.source];
      const target = points[edge.target];
      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const endpointWidth = (units[edge.source].width + units[edge.target].width) / 2;
      const desired = endpointWidth + (
        edge.kind === "gfa-link" ? 42 : edge.kind === "agp-gap" ? 50 : 20
      );
      const strength = edge.kind === "gfa-link" ? 0.045 : 0.075;
      const force = clampNumber((distance - desired) * strength * cooling, -7, 7);
      movement[edge.source].x += dx / distance * force;
      movement[edge.source].y += dy / distance * force;
      movement[edge.target].x -= dx / distance * force;
      movement[edge.target].y -= dy / distance * force;
    }

    for (const component of components) {
      const ordered = [...component].sort((left, right) => points[left].x - points[right].x);
      for (let leftRank = 0; leftRank < ordered.length; leftRank += 1) {
        const leftIndex = ordered[leftRank];
        const leftWidth = units[leftIndex].width;
        for (let rightRank = leftRank + 1; rightRank < ordered.length; rightRank += 1) {
          const rightIndex = ordered[rightRank];
          const rightWidth = units[rightIndex].width;
          const requiredX = (leftWidth + rightWidth) / 2 + 10;
          const dx = points[rightIndex].x - points[leftIndex].x;
          if (dx >= requiredX) {
            break;
          }
          const dy = points[rightIndex].y - points[leftIndex].y;
          const requiredY = 24;
          if (Math.abs(dy) >= requiredY) {
            continue;
          }
          const overlapX = requiredX - Math.abs(dx);
          const overlapY = requiredY - Math.abs(dy);
          if (overlapX < overlapY) {
            const push = Math.min(7, overlapX * 0.15 * cooling);
            movement[leftIndex].x -= push;
            movement[rightIndex].x += push;
          } else {
            const direction = dy === 0
              ? (stableHash(units[leftIndex].id, 23) % 2 === 0 ? 1 : -1)
              : Math.sign(dy);
            const push = Math.min(7, overlapY * 0.18 * cooling);
            movement[leftIndex].y -= direction * push;
            movement[rightIndex].y += direction * push;
          }
        }
      }
    }
    for (const [index, point] of points.entries()) {
      point.x += clampNumber(movement[index].x, -8, 8);
      point.y += clampNumber(movement[index].y, -8, 8);
    }
  }

  let shelfX = 60;
  let shelfY = 60;
  let rowHeight = 0;
  const targetRowWidth = Math.max(900, Math.sqrt(units.length) * 110);
  for (const component of components) {
    const minX = Math.min(...component.map((index) => (
      points[index].x - units[index].width / 2
    )));
    const maxX = Math.max(...component.map((index) => (
      points[index].x + units[index].width / 2
    )));
    const minY = Math.min(...component.map((index) => points[index].y));
    const maxY = Math.max(...component.map((index) => points[index].y));
    const width = Math.max(48, maxX - minX + 70);
    const height = Math.max(36, maxY - minY + 58);
    if (shelfX > 60 && shelfX + width > targetRowWidth) {
      shelfX = 60;
      shelfY += rowHeight + 48;
      rowHeight = 0;
    }
    for (const index of component) {
      points[index].x += shelfX - minX;
      points[index].y += shelfY - minY;
    }
    shelfX += width + 44;
    rowHeight = Math.max(rowHeight, height);
  }

  const nodePoints = new Map<string, GfaGraphPoint>();
  for (const [unitIndex, unit] of units.entries()) {
    let left = points[unitIndex].x - unit.width / 2;
    for (const memberIndex of unit.memberIndices) {
      const node = nodes[memberIndex];
      const width = nodeWidths.get(node.id) ?? bandageMinimumNodeWidth;
      nodePoints.set(node.id, { x: left + width / 2, y: points[unitIndex].y });
      left += width + 4;
    }
  }
  return nodePoints;
}

/**
 * AGP-guided local topology layout. Focal assembly blocks form immutable,
 * left-to-right scaffold backbones. One-hop GFA neighbors are placed in
 * crossing-reduced lanes above and below the backbone they support. The solve
 * is deterministic and never applies graph forces to the AGP order.
 */
export function layoutGfaNodesGuided(
  nodes: GfaHomologLayoutNode[],
  edges: GfaCurationLayoutEdge[],
  focalNodeIds: ReadonlySet<string>,
) {
  if (nodes.length === 0) {
    return new Map<string, GfaGraphPoint>();
  }
  const nodeWidths = gfaBandageNodeWidths(nodes);
  const unitsByKey = new Map<string, {
    id: string;
    groupId: string;
    memberIndices: number[];
    width: number;
    firstOrder: number;
    focal: boolean;
  }>();
  for (const [index, node] of nodes.entries()) {
    const key = rigidAssemblyBlockKey(node);
    const unit = unitsByKey.get(key) ?? {
      id: key,
      groupId: node.groupId,
      memberIndices: [],
      width: 0,
      firstOrder: node.order,
      focal: false,
    };
    unit.memberIndices.push(index);
    unit.firstOrder = Math.min(unit.firstOrder, node.order);
    unit.focal ||= focalNodeIds.has(node.id);
    unitsByKey.set(key, unit);
  }
  const units = [...unitsByKey.values()]
    .sort((left, right) => left.firstOrder - right.firstOrder || naturalCompare(left.id, right.id));
  for (const unit of units) {
    unit.memberIndices.sort((left, right) => (
      nodes[left].order - nodes[right].order || naturalCompare(nodes[left].id, nodes[right].id)
    ));
    unit.width = unit.memberIndices.reduce((total, index) => (
      total + (nodeWidths.get(nodes[index].id) ?? bandageMinimumNodeWidth)
    ), 0) + Math.max(0, unit.memberIndices.length - 1) * 4;
  }

  const unitIndexByNodeId = new Map<string, number>();
  for (const [unitIndex, unit] of units.entries()) {
    for (const memberIndex of unit.memberIndices) {
      unitIndexByNodeId.set(nodes[memberIndex].id, unitIndex);
    }
  }
  const focalUnitIds = new Set(
    units.flatMap((unit, index) => unit.focal ? [index] : []),
  );
  // A missing focus can happen briefly while the heatmap viewport is between
  // assemblies. Keep the result finite and useful instead of collapsing every
  // node onto the origin.
  if (focalUnitIds.size === 0) {
    return layoutGfaNodesBandage(nodes, edges);
  }

  const focalRows = new Map<string, number[]>();
  for (const unitIndex of focalUnitIds) {
    const values = focalRows.get(units[unitIndex].groupId) ?? [];
    values.push(unitIndex);
    focalRows.set(units[unitIndex].groupId, values);
  }
  const orderedRows = [...focalRows.entries()]
    .map(([groupId, unitIndices]) => ({
      groupId,
      unitIndices: unitIndices.sort((left, right) => (
        units[left].firstOrder - units[right].firstOrder
        || naturalCompare(units[left].id, units[right].id)
      )),
      firstOrder: Math.min(...unitIndices.map((index) => units[index].firstOrder)),
    }))
    .sort((left, right) => left.firstOrder - right.firstOrder || naturalCompare(left.groupId, right.groupId));

  const points = units.map(() => ({ x: 0, y: 0 }));
  const rowByFocalUnit = new Map<number, number>();
  const provisionalRowY = orderedRows.map((_, index) => 120 + index * 220);
  for (const [rowIndex, row] of orderedRows.entries()) {
    let cursorX = 100;
    for (const unitIndex of row.unitIndices) {
      points[unitIndex] = {
        x: cursorX + units[unitIndex].width / 2,
        y: provisionalRowY[rowIndex],
      };
      cursorX += units[unitIndex].width + 28;
      rowByFocalUnit.set(unitIndex, rowIndex);
    }
  }

  const linkedFocalUnits = units.map(() => [] as number[]);
  for (const edge of edges) {
    if (edge.kind !== "gfa-link") {
      continue;
    }
    const source = unitIndexByNodeId.get(edge.source);
    const target = unitIndexByNodeId.get(edge.target);
    if (source === undefined || target === undefined || source === target) {
      continue;
    }
    if (!focalUnitIds.has(source) && focalUnitIds.has(target)) {
      linkedFocalUnits[source].push(target);
    }
    if (!focalUnitIds.has(target) && focalUnitIds.has(source)) {
      linkedFocalUnits[target].push(source);
    }
  }

  interface GuidedNeighborPlacement {
    unitIndex: number;
    rowIndex: number;
    anchorX: number;
    side: -1 | 1;
    lane: number;
  }
  const candidates = units.flatMap((unit, unitIndex) => {
    if (unit.focal || linkedFocalUnits[unitIndex].length === 0) {
      return [];
    }
    const links = linkedFocalUnits[unitIndex];
    const rowCounts = new Map<number, number>();
    for (const focalIndex of links) {
      const rowIndex = rowByFocalUnit.get(focalIndex);
      if (rowIndex !== undefined) {
        rowCounts.set(rowIndex, (rowCounts.get(rowIndex) ?? 0) + 1);
      }
    }
    const rowIndex = [...rowCounts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0] - right[0])[0]?.[0] ?? 0;
    const sameRowLinks = links.filter((index) => rowByFocalUnit.get(index) === rowIndex);
    const anchorLinks = sameRowLinks.length > 0 ? sameRowLinks : links;
    return [{
      unitIndex,
      rowIndex,
      anchorX: anchorLinks.reduce((sum, index) => sum + points[index].x, 0) / anchorLinks.length,
    }];
  }).sort((left, right) => (
    left.rowIndex - right.rowIndex
    || left.anchorX - right.anchorX
    || naturalCompare(units[left.unitIndex].id, units[right.unitIndex].id)
  ));

  const laneRightEdges = new Map<string, number[]>();
  const placements: GuidedNeighborPlacement[] = [];
  for (const [rank, candidate] of candidates.entries()) {
    const side: -1 | 1 = rank % 2 === 0 ? -1 : 1;
    const laneKey = `${candidate.rowIndex}:${side}`;
    const rightEdges = laneRightEdges.get(laneKey) ?? [];
    const unit = units[candidate.unitIndex];
    let lane = rightEdges.findIndex((rightEdge) => (
      candidate.anchorX - unit.width / 2 >= rightEdge + 18
    ));
    if (lane < 0) {
      lane = rightEdges.length;
      rightEdges.push(Number.NEGATIVE_INFINITY);
    }
    const x = Math.max(
      candidate.anchorX,
      rightEdges[lane] + 18 + unit.width / 2,
    );
    rightEdges[lane] = x + unit.width / 2;
    laneRightEdges.set(laneKey, rightEdges);
    placements.push({ ...candidate, side, lane });
    points[candidate.unitIndex].x = x;
  }

  const aboveLaneCounts = orderedRows.map((_, rowIndex) => (
    laneRightEdges.get(`${rowIndex}:-1`)?.length ?? 0
  ));
  const belowLaneCounts = orderedRows.map((_, rowIndex) => (
    laneRightEdges.get(`${rowIndex}:1`)?.length ?? 0
  ));
  const rowY: number[] = [];
  for (let rowIndex = 0; rowIndex < orderedRows.length; rowIndex += 1) {
    rowY[rowIndex] = rowIndex === 0
      ? 80 + aboveLaneCounts[rowIndex] * 38
      : rowY[rowIndex - 1]
        + 96
        + belowLaneCounts[rowIndex - 1] * 38
        + aboveLaneCounts[rowIndex] * 38;
    for (const unitIndex of orderedRows[rowIndex].unitIndices) {
      points[unitIndex].y = rowY[rowIndex];
    }
  }
  for (const placement of placements) {
    points[placement.unitIndex].y = rowY[placement.rowIndex]
      + placement.side * (50 + placement.lane * 38);
  }

  // The local graph normally contains only focal units and their one-hop
  // neighbors. Any residual unit is packed to the right without affecting the
  // backbone, which keeps transient/import edge cases deterministic.
  const residual = units
    .map((_, index) => index)
    .filter((index) => !focalUnitIds.has(index) && linkedFocalUnits[index].length === 0);
  let residualX = Math.max(
    100,
    ...[...focalUnitIds].map((index) => points[index].x + units[index].width / 2),
  ) + 100;
  const residualY = rowY.length > 0 ? rowY.reduce((sum, value) => sum + value, 0) / rowY.length : 100;
  for (const unitIndex of residual) {
    points[unitIndex] = {
      x: residualX + units[unitIndex].width / 2,
      y: residualY,
    };
    residualX += units[unitIndex].width + 28;
  }

  const nodePoints = new Map<string, GfaGraphPoint>();
  for (const [unitIndex, unit] of units.entries()) {
    let left = points[unitIndex].x - unit.width / 2;
    for (const memberIndex of unit.memberIndices) {
      const node = nodes[memberIndex];
      const width = nodeWidths.get(node.id) ?? bandageMinimumNodeWidth;
      nodePoints.set(node.id, { x: left + width / 2, y: points[unitIndex].y });
      left += width + 4;
    }
  }
  return nodePoints;
}

export function gfaLinkScope(
  sourceScaffold: string,
  targetScaffold: string,
  homologs: GfaHomologClassification,
): GfaLinkScope {
  if (sourceScaffold === targetScaffold) {
    return "within-scaffold";
  }
  const homologByScaffold = new Map(
    homologs.columns.flatMap((column) => (
      column.scaffolds.map((scaffold) => [scaffold.id, column.id] as const)
    )),
  );
  const sourceHomolog = homologByScaffold.get(sourceScaffold);
  const targetHomolog = homologByScaffold.get(targetScaffold);
  return sourceHomolog && sourceHomolog === targetHomolog
    ? "homolog"
    : "non-homolog";
}

export function gfaBandageControlPoint(
  source: GfaGraphPoint,
  target: GfaGraphPoint,
  bendDirection: 1 | -1,
  ratio: number,
  minimumBend: number,
  maximumBend: number,
) {
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const distance = Math.max(1, Math.hypot(dx, dy));
  const bend = Math.min(maximumBend, Math.max(minimumBend, distance * ratio)) * bendDirection;
  return {
    x: (source.x + target.x) / 2 - dy / distance * bend,
    y: (source.y + target.y) / 2 + dx / distance * bend,
  };
}

function naturalCompare(left: string, right: string) {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

function assemblyBlockKey(node: GfaHomologLayoutNode) {
  return node.assemblyBlockId ?? `single:${node.id}`;
}

function rigidAssemblyBlockKey(node: GfaHomologLayoutNode) {
  return node.assemblyBlockId
    ? `block:${node.groupId}\0${node.assemblyBlockId}`
    : `single:${node.id}`;
}

function deterministicOffset(value: string) {
  let hash = 17;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  const angle = (Math.abs(hash) % 360) * Math.PI / 180;
  const radius = 44 + Math.abs(hash >> 8) % 44;
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

function deterministicAngle(value: string, salt: number) {
  return ((stableHash(value, salt) % 3_600) / 3_600) * Math.PI * 2;
}

function deterministicNudge(value: string, salt: number) {
  return (stableHash(value, salt) % 1_001) / 1_000 * 10 - 5;
}

function stableHash(value: string, salt: number) {
  let hash = salt;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

function clampNumber(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function finiteLength(length: number | undefined) {
  return Number.isFinite(length) && (length ?? 0) > 0 ? length! : 1;
}
