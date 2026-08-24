use std::{
    collections::HashSet,
    ffi::CString,
    path::Path,
    time::{Duration, Instant},
};

use hdf5::{types::VarLenUnicode, Dataset, File, Group, H5Type, Location};
use hdf5_sys::{h5i::hid_t, h5o::H5Ocopy, h5p::H5P_DEFAULT};
use rayon::{prelude::*, ThreadPool, ThreadPoolBuilder};

use crate::error::{Error, Result};

const PIXELS_PER_WORK_SPAN: usize = 500_000;
const PIXEL_DATASET_CHUNK: usize = 262_144;
const PIXEL_WRITE_BATCH_CHUNKS: usize = 4;
const PIXEL_WRITE_BUFFER_ELEMENTS: usize = PIXEL_DATASET_CHUNK * PIXEL_WRITE_BATCH_CHUNKS;
const RAW_CHUNK_CACHE_SLOTS: usize = 521;
const SOURCE_RAW_CHUNK_CACHE_BYTES: usize = 8 * 1024 * 1024;
const DESTINATION_RAW_CHUNK_CACHE_BYTES: usize = 16 * 1024 * 1024;
const RAW_CHUNK_CACHE_W0: f64 = 1.0;
pub const DEFAULT_COMPRESSION_LEVEL: u8 = 1;
pub const MAX_COMPRESSION_LEVEL: u8 = 9;

/// Aggregation strategy used to construct requested resolutions from the 1 kb input.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AggregationMode {
    /// Reuse the closest already-built divisor whenever one is available.
    Pyramid,
    /// Build every requested coarse level directly from the 1 kb input.
    Direct,
}

impl AggregationMode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Pyramid => "pyramid",
            Self::Direct => "direct",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CountStorage {
    I32,
    I64,
    F64,
}

#[derive(Debug, Clone, Copy)]
struct WorkSpan {
    pixel_start: usize,
    pixel_end: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ResolutionJob {
    parent: u64,
    resolution: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ResolutionWork {
    Single(ResolutionJob),
    SiblingPair([ResolutionJob; 2]),
}

#[derive(Clone)]
struct RawPixelChunk {
    bin1: Vec<u64>,
    bin2: Vec<u64>,
    counts: Vec<f64>,
}

struct AggregatedPixelChunk {
    keyed_counts: Vec<(u64, f64)>,
}

struct ChildBins {
    chrom_offsets: Vec<u64>,
    chromosomes: Vec<i32>,
    starts: Vec<u64>,
    ends: Vec<u64>,
}

enum CountDataset {
    I32(Dataset),
    I64(Dataset),
    F64(Dataset),
}

struct PixelWriter {
    bin1: Dataset,
    bin2: Dataset,
    counts: CountDataset,
    written: usize,
    buffer: Vec<(u64, f64)>,
    buffer_elements: usize,
    write_batches: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PixelWriterSummary {
    written: usize,
    write_batches: usize,
    final_batch_pixels: usize,
}

struct CoarsenParent {
    resolution: u64,
    group: Group,
    chromosome_lengths: Vec<u64>,
    chrom_offsets: Vec<u64>,
    bin1_offsets: Vec<u64>,
    bin1: Dataset,
    bin2: Dataset,
    counts: Dataset,
    count_storage: CountStorage,
    bin_count: usize,
    source_pixels: usize,
}

struct CoarsenTargetPlan {
    resolution: u64,
    child_chrom_offsets: Vec<u64>,
    child_bin_chrom: Vec<i32>,
    child_bin_starts: Vec<u64>,
    child_bin_ends: Vec<u64>,
    bin_map: Vec<u32>,
}

struct CoarsenTarget {
    resolution: u64,
    child_chrom_offsets: Vec<u64>,
    bin_map: Vec<u32>,
    row_counts: Vec<u64>,
    matrix_sum: f64,
    level: Group,
    writer: PixelWriter,
    phase_timings: CoarsenPhaseTimings,
    started: Instant,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct CoarsenPhaseTimings {
    read: Duration,
    aggregate: Duration,
    write: Duration,
    read_pixels: usize,
    append_calls: usize,
    write_batches: usize,
    final_batch_pixels: usize,
    shared_read_targets: usize,
}

impl CoarsenPhaseTimings {
    fn total(self) -> Duration {
        self.read + self.aggregate + self.write
    }
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct ZoomifyExecution {
    threads: usize,
    level_parallelism: usize,
    aggregation_mode: AggregationMode,
    compression_level: u8,
}

impl ZoomifyExecution {
    pub(crate) const fn new(
        threads: usize,
        level_parallelism: usize,
        aggregation_mode: AggregationMode,
        compression_level: u8,
    ) -> Self {
        Self {
            threads,
            level_parallelism,
            aggregation_mode,
            compression_level,
        }
    }
}

/// Generate an MCOOL v2 pyramid without invoking Python or the Cooler CLI.
///
/// HDF5 calls are serialized by the `hdf5` crate's global library lock. The
/// default pyramid strategy reuses parent levels; the direct strategy can make
/// all requested coarse levels independent. Their pixel chunks share one
/// bounded Rayon pool. Results within each level are committed in source-row
/// order. Work spans end only at a target bin1 row boundary, so a coarse pixel
/// key cannot cross workers and require a global merge.
pub fn rust_zoomify(
    input: &Path,
    output: &Path,
    resolutions: &[u64],
    threads: usize,
    level_parallelism: usize,
) -> Result<()> {
    rust_zoomify_with_mode(
        input,
        output,
        resolutions,
        threads,
        level_parallelism,
        AggregationMode::Pyramid,
    )
}

/// Generate an MCOOL v2 pyramid with an explicitly selected aggregation strategy.
pub fn rust_zoomify_with_mode(
    input: &Path,
    output: &Path,
    resolutions: &[u64],
    threads: usize,
    level_parallelism: usize,
    aggregation_mode: AggregationMode,
) -> Result<()> {
    rust_zoomify_with_mode_and_compression(
        input,
        output,
        resolutions,
        threads,
        level_parallelism,
        aggregation_mode,
        DEFAULT_COMPRESSION_LEVEL,
    )
}

/// Generate an MCOOL v2 pyramid with an explicit aggregation strategy and gzip level.
pub fn rust_zoomify_with_mode_and_compression(
    input: &Path,
    output: &Path,
    resolutions: &[u64],
    threads: usize,
    level_parallelism: usize,
    aggregation_mode: AggregationMode,
    compression_level: u8,
) -> Result<()> {
    let pool = build_worker_pool(threads)?;
    rust_zoomify_with_pool(
        input,
        output,
        resolutions,
        &pool,
        ZoomifyExecution::new(
            threads,
            level_parallelism,
            aggregation_mode,
            compression_level,
        ),
    )
}

pub(crate) fn build_worker_pool(threads: usize) -> Result<ThreadPool> {
    if threads == 0 {
        return Err(zoomify_error(
            "Rust processing requires at least one worker",
        ));
    }
    ThreadPoolBuilder::new()
        .num_threads(threads)
        .thread_name(|index| format!("cool2mcool-worker-{index}"))
        .build()
        .map_err(|error| zoomify_error(format!("failed to create worker pool: {error}")))
}

pub(crate) fn rust_zoomify_with_pool(
    input: &Path,
    output: &Path,
    resolutions: &[u64],
    pool: &ThreadPool,
    execution: ZoomifyExecution,
) -> Result<()> {
    let ZoomifyExecution {
        threads,
        level_parallelism,
        aggregation_mode,
        compression_level,
    } = execution;
    if threads == 0 {
        return Err(zoomify_error("Rust zoomify requires at least one worker"));
    }
    if level_parallelism == 0 || level_parallelism > threads {
        return Err(zoomify_error(format!(
            "Rust zoomify level parallelism must be between 1 and the worker count {threads}",
        )));
    }
    validate_compression_level(compression_level)?;

    let started = Instant::now();
    let source = open_source_file(input)?;
    let destination = create_destination_file(output)?;
    destination
        .create_group("resolutions")
        .map_err(|error| zoomify_error(format!("failed to create /resolutions: {error}")))?;
    if resolutions.contains(&1_000) {
        copy_object(source.id(), ".", destination.id(), "resolutions/1000")?;
        destination.flush().map_err(|error| {
            zoomify_error(format!("failed to flush copied 1000 bp level: {error}"))
        })?;
    }
    let input_level = source.group("/").map_err(|error| {
        zoomify_error(format!("failed to open the 1000 bp input level: {error}"))
    })?;

    let jobs = resolution_jobs(resolutions, aggregation_mode)?;
    coarsen_pyramid(&input_level, &destination, &jobs, pool, execution)?;

    write_string_attr(&destination, "format", "HDF5::MCOOL")?;
    write_u64_attr(&destination, "format-version", 2)?;
    destination
        .flush()
        .map_err(|error| zoomify_error(format!("failed to flush native MCOOL: {error}")))?;

    if performance_logging_enabled() {
        eprintln!(
            "COOL2MCOOL_PERF event=rust_zoomify status=complete aggregation_mode={} compression_level={} levels={} workers={} level_parallelism={} elapsed_ms={}",
            aggregation_mode.as_str(),
            compression_level,
            resolutions.len(),
            threads,
            level_parallelism,
            started.elapsed().as_millis(),
        );
    }
    Ok(())
}

fn open_source_file(input: &Path) -> Result<File> {
    File::with_options()
        .with_fapl(|fapl| {
            fapl.chunk_cache(
                RAW_CHUNK_CACHE_SLOTS,
                SOURCE_RAW_CHUNK_CACHE_BYTES,
                RAW_CHUNK_CACHE_W0,
            )
        })
        .open(input)
        .map_err(|error| {
            zoomify_error(format!(
                "failed to open input COOL {}: {error}",
                input.display()
            ))
        })
}

fn create_destination_file(output: &Path) -> Result<File> {
    File::with_options()
        .with_fapl(|fapl| {
            fapl.chunk_cache(
                RAW_CHUNK_CACHE_SLOTS,
                DESTINATION_RAW_CHUNK_CACHE_BYTES,
                RAW_CHUNK_CACHE_W0,
            )
        })
        .create(output)
        .map_err(|error| {
            zoomify_error(format!(
                "failed to create native MCOOL {}: {error}",
                output.display()
            ))
        })
}

fn resolution_jobs(
    resolutions: &[u64],
    aggregation_mode: AggregationMode,
) -> Result<Vec<ResolutionJob>> {
    let mut available = vec![1_000_u64];
    let mut jobs = Vec::with_capacity(resolutions.len().saturating_sub(1));
    for &resolution in resolutions {
        if resolution == 1_000 {
            continue;
        }
        let parent = match aggregation_mode {
            AggregationMode::Direct => 1_000,
            AggregationMode::Pyramid => available
                .iter()
                .rev()
                .copied()
                .find(|candidate| resolution % candidate == 0)
                .ok_or_else(|| {
                    zoomify_error(format!(
                        "resolution {resolution} cannot be derived from the 1000 bp input or an earlier level"
                    ))
                })?,
        };
        jobs.push(ResolutionJob { parent, resolution });
        available.push(resolution);
    }
    Ok(jobs)
}

fn coarsen_pyramid(
    input_level: &Group,
    file: &File,
    jobs: &[ResolutionJob],
    pool: &ThreadPool,
    execution: ZoomifyExecution,
) -> Result<()> {
    let ZoomifyExecution {
        threads,
        level_parallelism,
        aggregation_mode,
        compression_level,
    } = execution;
    let mut completed = HashSet::from([1_000_u64]);
    let mut pending = jobs.to_vec();

    while !pending.is_empty() {
        let batch = pending
            .iter()
            .copied()
            .filter(|job| completed.contains(&job.parent))
            .take(level_parallelism)
            .collect::<Vec<_>>();
        if batch.is_empty() {
            return Err(zoomify_error(
                "resolution dependency graph cannot make progress",
            ));
        }
        let batch_width = threads.div_ceil(batch.len()).max(1);
        let work = resolution_work_batch(&batch, aggregation_mode);
        if performance_logging_enabled() {
            eprintln!(
                "COOL2MCOOL_PERF event=rust_level_batch status=start lanes={} work_units={} fused_pairs={} batch_width={} resolutions={}",
                batch.len(),
                work.len(),
                work.iter()
                    .filter(|item| matches!(item, ResolutionWork::SiblingPair(_)))
                    .count(),
                batch_width,
                batch
                    .iter()
                    .map(|job| job.resolution.to_string())
                    .collect::<Vec<_>>()
                    .join(","),
            );
        }

        if work.len() == 1 {
            coarsen_work(
                work[0],
                input_level,
                file,
                pool,
                batch_width,
                compression_level,
            )?;
        } else {
            let results = std::thread::scope(|scope| {
                work.iter()
                    .copied()
                    .map(|item| {
                        scope.spawn(move || {
                            coarsen_work(
                                item,
                                input_level,
                                file,
                                pool,
                                batch_width,
                                compression_level,
                            )
                        })
                    })
                    .collect::<Vec<_>>()
                    .into_iter()
                    .map(|handle| handle.join())
                    .collect::<Vec<_>>()
            });
            for result in results {
                result.map_err(|_| zoomify_error("native zoomify level worker panicked"))??;
            }
        }

        for job in &batch {
            completed.insert(job.resolution);
        }
        pending.retain(|job| !completed.contains(&job.resolution));
    }
    Ok(())
}

fn resolution_work_batch(
    batch: &[ResolutionJob],
    aggregation_mode: AggregationMode,
) -> Vec<ResolutionWork> {
    if aggregation_mode != AggregationMode::Pyramid {
        return batch.iter().copied().map(ResolutionWork::Single).collect();
    }

    let mut used = vec![false; batch.len()];
    let mut work = Vec::with_capacity(batch.len());
    for first_index in 0..batch.len() {
        if used[first_index] {
            continue;
        }
        let first = batch[first_index];
        let partner = ((first_index + 1)..batch.len()).find(|&second_index| {
            !used[second_index] && sibling_pair_span_factor(first, batch[second_index]).is_some()
        });
        if let Some(second_index) = partner {
            used[first_index] = true;
            used[second_index] = true;
            work.push(ResolutionWork::SiblingPair([first, batch[second_index]]));
        } else {
            used[first_index] = true;
            work.push(ResolutionWork::Single(first));
        }
    }
    work
}

fn sibling_pair_span_factor(first: ResolutionJob, second: ResolutionJob) -> Option<usize> {
    if first.parent != second.parent
        || first.resolution % first.parent != 0
        || second.resolution % second.parent != 0
    {
        return None;
    }
    let first_factor = usize::try_from(first.resolution / first.parent).ok()?;
    let second_factor = usize::try_from(second.resolution / second.parent).ok()?;
    let shared_factor = checked_lcm(first_factor, second_factor)?;
    let maximum_factor = first_factor.max(second_factor);
    if shared_factor <= maximum_factor.checked_mul(2)? {
        Some(shared_factor)
    } else {
        None
    }
}

fn checked_lcm(first: usize, second: usize) -> Option<usize> {
    if first == 0 || second == 0 {
        return None;
    }
    let mut left = first;
    let mut right = second;
    while right != 0 {
        let remainder = left % right;
        left = right;
        right = remainder;
    }
    first.checked_div(left)?.checked_mul(second)
}

fn coarsen_work(
    work: ResolutionWork,
    input_level: &Group,
    file: &File,
    pool: &ThreadPool,
    batch_width: usize,
    compression_level: u8,
) -> Result<()> {
    match work {
        ResolutionWork::Single(job) => coarsen_level(
            input_level,
            file,
            job.parent,
            job.resolution,
            pool,
            batch_width,
            compression_level,
        ),
        ResolutionWork::SiblingPair(jobs) => coarsen_sibling_pair(
            input_level,
            file,
            jobs,
            pool,
            batch_width,
            compression_level,
        ),
    }
}

fn coarsen_sibling_pair(
    input_level: &Group,
    file: &File,
    jobs: [ResolutionJob; 2],
    pool: &ThreadPool,
    batch_width: usize,
    compression_level: u8,
) -> Result<()> {
    let started = Instant::now();
    let parent_resolution = jobs[0].parent;
    let shared_factor = sibling_pair_span_factor(jobs[0], jobs[1]).ok_or_else(|| {
        zoomify_error(format!(
            "resolutions {} and {} are not eligible for shared parent reading",
            jobs[0].resolution, jobs[1].resolution
        ))
    })?;
    let (parent, parent_read) = load_coarsen_parent(input_level, file, parent_resolution)?;

    let planning_started = Instant::now();
    let mut plans = Vec::with_capacity(2);
    let mut timings = [CoarsenPhaseTimings {
        shared_read_targets: 2,
        ..CoarsenPhaseTimings::default()
    }; 2];
    for (index, job) in jobs.iter().enumerate() {
        timings[index].read += parent_read;
        let aggregate_started = Instant::now();
        plans.push(prepare_coarsen_target_plan(
            &parent,
            parent_resolution,
            job.resolution,
        )?);
        timings[index].aggregate += aggregate_started.elapsed();
    }
    let span_started = Instant::now();
    let shared_spans =
        build_work_spans_for_factor(&parent.bin1_offsets, &parent.chrom_offsets, shared_factor)?;
    let span_elapsed = span_started.elapsed();
    for timing in &mut timings {
        timing.aggregate += span_elapsed;
    }
    let mut physical_aggregate = planning_started.elapsed();

    let create_started = Instant::now();
    let mut targets = plans
        .into_iter()
        .zip(timings)
        .map(|(plan, phase_timings)| {
            create_coarsen_target(
                &parent,
                file,
                plan,
                phase_timings,
                started,
                compression_level,
            )
        })
        .collect::<Result<Vec<_>>>()?;
    let mut physical_write = create_started.elapsed();

    let mut physical_read = parent_read;
    let mut physical_read_pixels = 0_usize;
    for span_batch in shared_spans.chunks(batch_width.max(1)) {
        let read_started = Instant::now();
        let raw = span_batch
            .iter()
            .map(|span| read_pixel_chunk(&parent.bin1, &parent.bin2, &parent.counts, *span))
            .collect::<Result<Vec<_>>>()?;
        let read_elapsed = read_started.elapsed();
        let batch_pixels = raw.iter().map(|chunk| chunk.counts.len()).sum::<usize>();
        physical_read += read_elapsed;
        physical_read_pixels = physical_read_pixels.saturating_add(batch_pixels);
        for target in &mut targets {
            target.phase_timings.read += read_elapsed;
            target.phase_timings.read_pixels = target
                .phase_timings
                .read_pixels
                .saturating_add(batch_pixels);
        }

        let aggregate_started = Instant::now();
        let aggregated = {
            let first_map = targets[0].bin_map.as_slice();
            let second_map = targets[1].bin_map.as_slice();
            pool.install(|| {
                raw.into_par_iter()
                    .map(|chunk| aggregate_sibling_chunk(chunk, first_map, second_map))
                    .collect::<Result<Vec<_>>>()
            })?
        };
        let aggregate_elapsed = aggregate_started.elapsed();
        physical_aggregate += aggregate_elapsed;
        for target in &mut targets {
            target.phase_timings.aggregate += aggregate_elapsed;
        }

        for (first_chunk, second_chunk) in aggregated {
            let (first, second) = targets.split_at_mut(1);
            let (aggregate, write) = commit_aggregated_chunk(&mut first[0], first_chunk)?;
            physical_aggregate += aggregate;
            physical_write += write;
            let (aggregate, write) = commit_aggregated_chunk(&mut second[0], second_chunk)?;
            physical_aggregate += aggregate;
            physical_write += write;
        }
    }

    let resolution_list = jobs
        .iter()
        .map(|job| job.resolution.to_string())
        .collect::<Vec<_>>()
        .join(",");
    for target in targets {
        let (aggregate, write) =
            finish_coarsen_target(&parent, target, shared_spans.len(), compression_level)?;
        physical_aggregate += aggregate;
        physical_write += write;
    }
    if performance_logging_enabled() {
        let elapsed = started.elapsed();
        let other = elapsed.saturating_sub(physical_read + physical_aggregate + physical_write);
        eprintln!(
            "COOL2MCOOL_PERF event=rust_coarsen_siblings status=complete parent_resolution={} resolutions={} source_spans_read={} hdf5_slice_reads={} physical_read_pixels={} logical_target_pixels={} read_ms={} aggregate_ms={} write_ms={} other_ms={} elapsed_ms={}",
            parent_resolution,
            resolution_list,
            shared_spans.len(),
            shared_spans.len().saturating_mul(3),
            physical_read_pixels,
            physical_read_pixels.saturating_mul(2),
            physical_read.as_millis(),
            physical_aggregate.as_millis(),
            physical_write.as_millis(),
            other.as_millis(),
            elapsed.as_millis(),
        );
    }
    Ok(())
}

fn load_coarsen_parent(
    input_level: &Group,
    file: &File,
    parent_resolution: u64,
) -> Result<(CoarsenParent, Duration)> {
    let started = Instant::now();
    let group = if parent_resolution == 1_000 {
        input_level.clone()
    } else {
        file.group(&format!("resolutions/{parent_resolution}"))
            .map_err(|error| {
                zoomify_error(format!(
                    "missing parent resolution {parent_resolution}: {error}"
                ))
            })?
    };
    let chromosome_lengths = read_u64_dataset(
        &group
            .dataset("chroms/length")
            .map_err(|error| zoomify_error(format!("missing chroms/length: {error}")))?,
    )?;
    let chrom_offsets = read_u64_dataset(
        &group
            .dataset("indexes/chrom_offset")
            .map_err(|error| zoomify_error(format!("missing indexes/chrom_offset: {error}")))?,
    )?;
    if chrom_offsets.len() != chromosome_lengths.len() + 1 {
        return Err(zoomify_error(format!(
            "resolution {parent_resolution} chrom_offset length does not match chromosomes"
        )));
    }
    let bin_count = usize::try_from(*chrom_offsets.last().unwrap_or(&0))
        .map_err(|_| zoomify_error("parent bin count exceeds usize"))?;
    let bin1_offsets = read_u64_dataset(
        &group
            .dataset("indexes/bin1_offset")
            .map_err(|error| zoomify_error(format!("missing indexes/bin1_offset: {error}")))?,
    )?;
    if bin1_offsets.len() != bin_count + 1 {
        return Err(zoomify_error(format!(
            "resolution {parent_resolution} bin1_offset length does not match bins"
        )));
    }
    let bin1 = group
        .dataset("pixels/bin1_id")
        .map_err(|error| zoomify_error(format!("missing pixels/bin1_id: {error}")))?;
    let bin2 = group
        .dataset("pixels/bin2_id")
        .map_err(|error| zoomify_error(format!("missing pixels/bin2_id: {error}")))?;
    let counts = group
        .dataset("pixels/count")
        .map_err(|error| zoomify_error(format!("missing pixels/count: {error}")))?;
    let source_pixels = bin1.size();
    if bin2.size() != source_pixels || counts.size() != source_pixels {
        return Err(zoomify_error(
            "parent pixel columns have inconsistent lengths",
        ));
    }
    let count_storage = count_storage(&counts)?;
    Ok((
        CoarsenParent {
            resolution: parent_resolution,
            group,
            chromosome_lengths,
            chrom_offsets,
            bin1_offsets,
            bin1,
            bin2,
            counts,
            count_storage,
            bin_count,
            source_pixels,
        },
        started.elapsed(),
    ))
}

fn prepare_coarsen_target_plan(
    parent: &CoarsenParent,
    parent_resolution: u64,
    resolution: u64,
) -> Result<CoarsenTargetPlan> {
    if resolution % parent_resolution != 0 {
        return Err(zoomify_error(format!(
            "resolution {resolution} is not divisible by parent {parent_resolution}"
        )));
    }
    let factor_u64 = resolution / parent_resolution;
    let factor = usize::try_from(factor_u64)
        .map_err(|_| zoomify_error(format!("coarsening factor {factor_u64} exceeds usize")))?;
    if factor < 2 {
        return Err(zoomify_error(format!(
            "resolution {resolution} must be coarser than {parent_resolution}"
        )));
    }
    let ChildBins {
        chrom_offsets: child_chrom_offsets,
        chromosomes: child_bin_chrom,
        starts: child_bin_starts,
        ends: child_bin_ends,
    } = build_child_bins(&parent.chromosome_lengths, resolution)?;
    if child_bin_starts.len() > u32::MAX as usize {
        return Err(zoomify_error(format!(
            "resolution {resolution} has {} bins, exceeding u32",
            child_bin_starts.len()
        )));
    }
    let bin_map = build_bin_map(
        &parent.chrom_offsets,
        &child_chrom_offsets,
        factor,
        parent.bin_count,
    )?;
    Ok(CoarsenTargetPlan {
        resolution,
        child_chrom_offsets,
        child_bin_chrom,
        child_bin_starts,
        child_bin_ends,
        bin_map,
    })
}

fn create_coarsen_target(
    parent: &CoarsenParent,
    file: &File,
    plan: CoarsenTargetPlan,
    mut phase_timings: CoarsenPhaseTimings,
    started: Instant,
    compression_level: u8,
) -> Result<CoarsenTarget> {
    let write_started = Instant::now();
    let level = file
        .create_group(&format!("resolutions/{}", plan.resolution))
        .map_err(|error| {
            zoomify_error(format!(
                "failed to create resolution {}: {error}",
                plan.resolution
            ))
        })?;
    copy_object(parent.group.id(), "chroms", level.id(), "chroms")?;
    write_bin_table(
        &level,
        &plan.child_bin_chrom,
        &plan.child_bin_starts,
        &plan.child_bin_ends,
        compression_level,
    )?;
    let writer = PixelWriter::create(&level, parent.count_storage, compression_level)?;
    phase_timings.write += write_started.elapsed();
    let row_counts = vec![0_u64; plan.child_bin_starts.len()];
    Ok(CoarsenTarget {
        resolution: plan.resolution,
        child_chrom_offsets: plan.child_chrom_offsets,
        bin_map: plan.bin_map,
        row_counts,
        matrix_sum: 0.0,
        level,
        writer,
        phase_timings,
        started,
    })
}

fn commit_aggregated_chunk(
    target: &mut CoarsenTarget,
    chunk: AggregatedPixelChunk,
) -> Result<(Duration, Duration)> {
    let aggregate_started = Instant::now();
    for &(key, count) in &chunk.keyed_counts {
        let first = (key >> 32) as usize;
        if first >= target.row_counts.len() {
            return Err(zoomify_error("aggregated bin1 exceeds child bin table"));
        }
        target.row_counts[first] = target.row_counts[first].saturating_add(1);
        target.matrix_sum += count;
    }
    let aggregate = aggregate_started.elapsed();
    target.phase_timings.aggregate += aggregate;

    let has_pixels = !chunk.keyed_counts.is_empty();
    let write_started = Instant::now();
    target.writer.append(&chunk.keyed_counts)?;
    let write = write_started.elapsed();
    target.phase_timings.write += write;
    if has_pixels {
        target.phase_timings.append_calls = target.phase_timings.append_calls.saturating_add(1);
    }
    Ok((aggregate, write))
}

fn finish_coarsen_target(
    parent: &CoarsenParent,
    target: CoarsenTarget,
    span_count: usize,
    compression_level: u8,
) -> Result<(Duration, Duration)> {
    let CoarsenTarget {
        resolution,
        child_chrom_offsets,
        row_counts,
        matrix_sum,
        level,
        writer,
        mut phase_timings,
        started,
        ..
    } = target;
    let write_started = Instant::now();
    let writer_summary = writer.finish()?;
    let writer_finish = write_started.elapsed();
    phase_timings.write += writer_finish;
    phase_timings.write_batches = writer_summary.write_batches;
    phase_timings.final_batch_pixels = writer_summary.final_batch_pixels;

    let aggregate_started = Instant::now();
    let bin1_offsets = prefix_offsets(&row_counts)?;
    let aggregate = aggregate_started.elapsed();
    phase_timings.aggregate += aggregate;

    let write_started = Instant::now();
    write_indexes(
        &level,
        &child_chrom_offsets,
        &bin1_offsets,
        compression_level,
    )?;
    write_level_attributes(
        &parent.group,
        &level,
        resolution,
        parent.chromosome_lengths.len(),
        row_counts.len(),
        writer_summary.written,
        matrix_sum,
    )?;
    let index_and_attributes = write_started.elapsed();
    phase_timings.write += index_and_attributes;
    if performance_logging_enabled() {
        eprintln!(
            "{}",
            coarsen_performance_line(
                parent.resolution,
                resolution,
                parent.source_pixels,
                writer_summary.written,
                span_count,
                phase_timings,
                started.elapsed(),
            )
        );
    }
    Ok((aggregate, writer_finish + index_and_attributes))
}

fn coarsen_level(
    input_level: &Group,
    file: &File,
    parent_resolution: u64,
    resolution: u64,
    pool: &ThreadPool,
    batch_width: usize,
    compression_level: u8,
) -> Result<()> {
    let started = Instant::now();
    let mut phase_timings = CoarsenPhaseTimings {
        shared_read_targets: 1,
        ..CoarsenPhaseTimings::default()
    };
    let factor_u64 = resolution / parent_resolution;
    let factor = usize::try_from(factor_u64)
        .map_err(|_| zoomify_error(format!("coarsening factor {factor_u64} exceeds usize")))?;
    if factor < 2 {
        return Err(zoomify_error(format!(
            "resolution {resolution} must be coarser than {parent_resolution}"
        )));
    }

    let read_started = Instant::now();
    let parent = if parent_resolution == 1_000 {
        input_level.clone()
    } else {
        file.group(&format!("resolutions/{parent_resolution}"))
            .map_err(|error| {
                zoomify_error(format!(
                    "missing parent resolution {parent_resolution}: {error}"
                ))
            })?
    };
    let chromosome_lengths = read_u64_dataset(
        &parent
            .dataset("chroms/length")
            .map_err(|error| zoomify_error(format!("missing chroms/length: {error}")))?,
    )?;
    let parent_chrom_offsets = read_u64_dataset(
        &parent
            .dataset("indexes/chrom_offset")
            .map_err(|error| zoomify_error(format!("missing indexes/chrom_offset: {error}")))?,
    )?;
    phase_timings.read += read_started.elapsed();

    let aggregate_started = Instant::now();
    if parent_chrom_offsets.len() != chromosome_lengths.len() + 1 {
        return Err(zoomify_error(format!(
            "resolution {parent_resolution} chrom_offset length does not match chromosomes"
        )));
    }

    let ChildBins {
        chrom_offsets: child_chrom_offsets,
        chromosomes: child_bin_chrom,
        starts: child_bin_starts,
        ends: child_bin_ends,
    } = build_child_bins(&chromosome_lengths, resolution)?;
    let child_bin_count = child_bin_starts.len();
    if child_bin_count > u32::MAX as usize {
        return Err(zoomify_error(format!(
            "resolution {resolution} has {child_bin_count} bins, exceeding u32"
        )));
    }

    let parent_bin_count = usize::try_from(*parent_chrom_offsets.last().unwrap_or(&0))
        .map_err(|_| zoomify_error("parent bin count exceeds usize"))?;
    let bin_map = build_bin_map(
        &parent_chrom_offsets,
        &child_chrom_offsets,
        factor,
        parent_bin_count,
    )?;
    phase_timings.aggregate += aggregate_started.elapsed();

    let read_started = Instant::now();
    let parent_bin1_offsets = read_u64_dataset(
        &parent
            .dataset("indexes/bin1_offset")
            .map_err(|error| zoomify_error(format!("missing indexes/bin1_offset: {error}")))?,
    )?;
    phase_timings.read += read_started.elapsed();

    let aggregate_started = Instant::now();
    if parent_bin1_offsets.len() != parent_bin_count + 1 {
        return Err(zoomify_error(format!(
            "resolution {parent_resolution} bin1_offset length does not match bins"
        )));
    }
    let spans = build_work_spans(
        &parent_bin1_offsets,
        &parent_chrom_offsets,
        &child_chrom_offsets,
        factor,
    )?;
    phase_timings.aggregate += aggregate_started.elapsed();

    let write_started = Instant::now();
    let level = file
        .create_group(&format!("resolutions/{resolution}"))
        .map_err(|error| {
            zoomify_error(format!("failed to create resolution {resolution}: {error}"))
        })?;
    copy_object(parent.id(), "chroms", level.id(), "chroms")?;
    write_bin_table(
        &level,
        &child_bin_chrom,
        &child_bin_starts,
        &child_bin_ends,
        compression_level,
    )?;
    phase_timings.write += write_started.elapsed();

    let read_started = Instant::now();
    let count_storage = count_storage(
        &parent
            .dataset("pixels/count")
            .map_err(|error| zoomify_error(format!("missing pixels/count: {error}")))?,
    )?;
    phase_timings.read += read_started.elapsed();

    let write_started = Instant::now();
    let mut writer = PixelWriter::create(&level, count_storage, compression_level)?;
    phase_timings.write += write_started.elapsed();

    let aggregate_started = Instant::now();
    let mut row_counts = vec![0_u64; child_bin_count];
    let mut matrix_sum = 0.0_f64;
    phase_timings.aggregate += aggregate_started.elapsed();

    let read_started = Instant::now();
    let parent_bin1 = parent
        .dataset("pixels/bin1_id")
        .map_err(|error| zoomify_error(format!("missing pixels/bin1_id: {error}")))?;
    let parent_bin2 = parent
        .dataset("pixels/bin2_id")
        .map_err(|error| zoomify_error(format!("missing pixels/bin2_id: {error}")))?;
    let parent_counts = parent
        .dataset("pixels/count")
        .map_err(|error| zoomify_error(format!("missing pixels/count: {error}")))?;
    let source_pixels = parent_bin1.size();
    phase_timings.read += read_started.elapsed();

    for span_batch in spans.chunks(batch_width.max(1)) {
        let read_started = Instant::now();
        let raw = span_batch
            .iter()
            .map(|span| read_pixel_chunk(&parent_bin1, &parent_bin2, &parent_counts, *span))
            .collect::<Result<Vec<_>>>()?;
        phase_timings.read += read_started.elapsed();
        phase_timings.read_pixels = phase_timings
            .read_pixels
            .saturating_add(raw.iter().map(|chunk| chunk.counts.len()).sum::<usize>());

        let aggregate_started = Instant::now();
        let aggregated = pool.install(|| {
            raw.into_par_iter()
                .map(|chunk| aggregate_chunk(chunk, &bin_map))
                .collect::<Result<Vec<_>>>()
        })?;
        phase_timings.aggregate += aggregate_started.elapsed();
        for chunk in aggregated {
            let aggregate_started = Instant::now();
            for &(key, count) in &chunk.keyed_counts {
                let first = (key >> 32) as usize;
                if first >= row_counts.len() {
                    return Err(zoomify_error("aggregated bin1 exceeds child bin table"));
                }
                row_counts[first] = row_counts[first].saturating_add(1);
                matrix_sum += count;
            }
            phase_timings.aggregate += aggregate_started.elapsed();

            let has_pixels = !chunk.keyed_counts.is_empty();
            let write_started = Instant::now();
            writer.append(&chunk.keyed_counts)?;
            phase_timings.write += write_started.elapsed();
            if has_pixels {
                phase_timings.append_calls = phase_timings.append_calls.saturating_add(1);
            }
        }
    }

    let write_started = Instant::now();
    let writer_summary = writer.finish()?;
    phase_timings.write += write_started.elapsed();
    phase_timings.write_batches = writer_summary.write_batches;
    phase_timings.final_batch_pixels = writer_summary.final_batch_pixels;

    let aggregate_started = Instant::now();
    let bin1_offsets = prefix_offsets(&row_counts)?;
    phase_timings.aggregate += aggregate_started.elapsed();

    let write_started = Instant::now();
    write_indexes(
        &level,
        &child_chrom_offsets,
        &bin1_offsets,
        compression_level,
    )?;
    write_level_attributes(
        &parent,
        &level,
        resolution,
        chromosome_lengths.len(),
        child_bin_count,
        writer_summary.written,
        matrix_sum,
    )?;
    phase_timings.write += write_started.elapsed();
    if performance_logging_enabled() {
        eprintln!(
            "{}",
            coarsen_performance_line(
                parent_resolution,
                resolution,
                source_pixels,
                writer_summary.written,
                spans.len(),
                phase_timings,
                started.elapsed(),
            )
        );
    }
    Ok(())
}

fn coarsen_performance_line(
    parent_resolution: u64,
    resolution: u64,
    source_pixels: usize,
    written_pixels: usize,
    span_count: usize,
    phase_timings: CoarsenPhaseTimings,
    elapsed: Duration,
) -> String {
    let other = elapsed.saturating_sub(phase_timings.total());
    format!(
        "COOL2MCOOL_PERF event=rust_coarsen status=complete source_resolution={} resolution={} source_pixels={} read_pixels={} pixels={} spans={} shared_read_targets={} append_calls={} write_batches={} final_batch_pixels={} read_ms={} aggregate_ms={} write_ms={} other_ms={} elapsed_ms={}",
            parent_resolution,
            resolution,
            source_pixels,
            phase_timings.read_pixels,
            written_pixels,
            span_count,
            phase_timings.shared_read_targets,
            phase_timings.append_calls,
            phase_timings.write_batches,
            phase_timings.final_batch_pixels,
            phase_timings.read.as_millis(),
            phase_timings.aggregate.as_millis(),
            phase_timings.write.as_millis(),
            other.as_millis(),
            elapsed.as_millis(),
    )
}

fn build_child_bins(chromosome_lengths: &[u64], resolution: u64) -> Result<ChildBins> {
    let mut offsets = Vec::with_capacity(chromosome_lengths.len() + 1);
    let mut chromosomes = Vec::new();
    let mut starts = Vec::new();
    let mut ends = Vec::new();
    offsets.push(0);
    for (chromosome, &length) in chromosome_lengths.iter().enumerate() {
        let chromosome =
            i32::try_from(chromosome).map_err(|_| zoomify_error("chromosome count exceeds i32"))?;
        let mut start = 0_u64;
        while start < length {
            chromosomes.push(chromosome);
            starts.push(start);
            ends.push(start.saturating_add(resolution).min(length));
            start = start.saturating_add(resolution);
        }
        offsets.push(starts.len() as u64);
    }
    Ok(ChildBins {
        chrom_offsets: offsets,
        chromosomes,
        starts,
        ends,
    })
}

fn build_bin_map(
    parent_chrom_offsets: &[u64],
    child_chrom_offsets: &[u64],
    factor: usize,
    parent_bin_count: usize,
) -> Result<Vec<u32>> {
    let mut map = vec![0_u32; parent_bin_count];
    for chromosome in 0..parent_chrom_offsets.len().saturating_sub(1) {
        let parent_start = usize::try_from(parent_chrom_offsets[chromosome])
            .map_err(|_| zoomify_error("parent chromosome offset exceeds usize"))?;
        let parent_end = usize::try_from(parent_chrom_offsets[chromosome + 1])
            .map_err(|_| zoomify_error("parent chromosome offset exceeds usize"))?;
        let child_start = usize::try_from(child_chrom_offsets[chromosome])
            .map_err(|_| zoomify_error("child chromosome offset exceeds usize"))?;
        for (parent_bin, mapped_bin) in map
            .iter_mut()
            .enumerate()
            .take(parent_end)
            .skip(parent_start)
        {
            *mapped_bin = u32::try_from(child_start + (parent_bin - parent_start) / factor)
                .map_err(|_| zoomify_error("child bin index exceeds u32"))?;
        }
    }
    Ok(map)
}

fn build_work_spans(
    bin1_offsets: &[u64],
    parent_chrom_offsets: &[u64],
    child_chrom_offsets: &[u64],
    factor: usize,
) -> Result<Vec<WorkSpan>> {
    let mut spans = Vec::new();
    let mut pending_start = None;
    let mut pending_end = 0_usize;
    let mut pending_pixels = 0_usize;

    for chromosome in 0..parent_chrom_offsets.len().saturating_sub(1) {
        let parent_start = usize::try_from(parent_chrom_offsets[chromosome])
            .map_err(|_| zoomify_error("parent chromosome offset exceeds usize"))?;
        let parent_end = usize::try_from(parent_chrom_offsets[chromosome + 1])
            .map_err(|_| zoomify_error("parent chromosome offset exceeds usize"))?;
        let child_start = usize::try_from(child_chrom_offsets[chromosome])
            .map_err(|_| zoomify_error("child chromosome offset exceeds usize"))?;
        let child_end = usize::try_from(child_chrom_offsets[chromosome + 1])
            .map_err(|_| zoomify_error("child chromosome offset exceeds usize"))?;
        for local_child in 0..child_end.saturating_sub(child_start) {
            let first_parent = parent_start + local_child.saturating_mul(factor);
            let last_parent = first_parent.saturating_add(factor).min(parent_end);
            let pixel_start = usize::try_from(bin1_offsets[first_parent])
                .map_err(|_| zoomify_error("pixel offset exceeds usize"))?;
            let pixel_end = usize::try_from(bin1_offsets[last_parent])
                .map_err(|_| zoomify_error("pixel offset exceeds usize"))?;
            let row_pixels = pixel_end.saturating_sub(pixel_start);
            if pending_start.is_some()
                && pending_pixels > 0
                && pending_pixels.saturating_add(row_pixels) > PIXELS_PER_WORK_SPAN
            {
                spans.push(WorkSpan {
                    pixel_start: pending_start.unwrap_or(pending_end),
                    pixel_end: pending_end,
                });
                pending_start = None;
                pending_pixels = 0;
            }
            pending_start.get_or_insert(pixel_start);
            pending_end = pixel_end;
            pending_pixels = pending_pixels.saturating_add(row_pixels);
        }
    }
    if let Some(pixel_start) = pending_start {
        if pending_end > pixel_start {
            spans.push(WorkSpan {
                pixel_start,
                pixel_end: pending_end,
            });
        }
    }
    Ok(spans)
}

fn build_work_spans_for_factor(
    bin1_offsets: &[u64],
    parent_chrom_offsets: &[u64],
    factor: usize,
) -> Result<Vec<WorkSpan>> {
    if factor == 0 {
        return Err(zoomify_error("shared work span factor must be positive"));
    }
    let mut spans = Vec::new();
    let mut pending_start = None;
    let mut pending_end = 0_usize;
    let mut pending_pixels = 0_usize;

    for chromosome in 0..parent_chrom_offsets.len().saturating_sub(1) {
        let parent_start = usize::try_from(parent_chrom_offsets[chromosome])
            .map_err(|_| zoomify_error("parent chromosome offset exceeds usize"))?;
        let parent_end = usize::try_from(parent_chrom_offsets[chromosome + 1])
            .map_err(|_| zoomify_error("parent chromosome offset exceeds usize"))?;
        for first_parent in (parent_start..parent_end).step_by(factor) {
            let last_parent = first_parent.saturating_add(factor).min(parent_end);
            let pixel_start = usize::try_from(bin1_offsets[first_parent])
                .map_err(|_| zoomify_error("pixel offset exceeds usize"))?;
            let pixel_end = usize::try_from(bin1_offsets[last_parent])
                .map_err(|_| zoomify_error("pixel offset exceeds usize"))?;
            let row_pixels = pixel_end.saturating_sub(pixel_start);
            if pending_start.is_some()
                && pending_pixels > 0
                && pending_pixels.saturating_add(row_pixels) > PIXELS_PER_WORK_SPAN
            {
                spans.push(WorkSpan {
                    pixel_start: pending_start.unwrap_or(pending_end),
                    pixel_end: pending_end,
                });
                pending_start = None;
                pending_pixels = 0;
            }
            pending_start.get_or_insert(pixel_start);
            pending_end = pixel_end;
            pending_pixels = pending_pixels.saturating_add(row_pixels);
        }
    }
    if let Some(pixel_start) = pending_start {
        if pending_end > pixel_start {
            spans.push(WorkSpan {
                pixel_start,
                pixel_end: pending_end,
            });
        }
    }
    Ok(spans)
}

fn read_pixel_chunk(
    bin1: &Dataset,
    bin2: &Dataset,
    counts: &Dataset,
    span: WorkSpan,
) -> Result<RawPixelChunk> {
    let range = span.pixel_start..span.pixel_end;
    let first = bin1
        .read_slice_1d::<u64, _>(range.clone())
        .map_err(|error| zoomify_error(format!("failed to read bin1 chunk: {error}")))?
        .to_vec();
    let second = bin2
        .read_slice_1d::<u64, _>(range.clone())
        .map_err(|error| zoomify_error(format!("failed to read bin2 chunk: {error}")))?
        .to_vec();
    let values = counts
        .read_slice_1d::<f64, _>(range)
        .map_err(|error| zoomify_error(format!("failed to read count chunk: {error}")))?
        .to_vec();
    if first.len() != second.len() || first.len() != values.len() {
        return Err(zoomify_error(
            "pixel columns changed length during chunk read",
        ));
    }
    Ok(RawPixelChunk {
        bin1: first,
        bin2: second,
        counts: values,
    })
}

fn aggregate_chunk(chunk: RawPixelChunk, bin_map: &[u32]) -> Result<AggregatedPixelChunk> {
    let mut keyed_counts = Vec::with_capacity(chunk.counts.len());
    for ((first, second), count) in chunk.bin1.into_iter().zip(chunk.bin2).zip(chunk.counts) {
        keyed_counts.push((mapped_pixel_key(first, second, bin_map)?, count));
    }

    Ok(stable_reduce_keyed(keyed_counts))
}

fn aggregate_sibling_chunk(
    chunk: RawPixelChunk,
    first_bin_map: &[u32],
    second_bin_map: &[u32],
) -> Result<(AggregatedPixelChunk, AggregatedPixelChunk)> {
    let mut first_keyed = Vec::with_capacity(chunk.counts.len());
    let mut second_keyed = Vec::with_capacity(chunk.counts.len());
    for ((first, second), count) in chunk.bin1.into_iter().zip(chunk.bin2).zip(chunk.counts) {
        first_keyed.push((mapped_pixel_key(first, second, first_bin_map)?, count));
        second_keyed.push((mapped_pixel_key(first, second, second_bin_map)?, count));
    }

    Ok(rayon::join(
        || stable_reduce_keyed(first_keyed),
        || stable_reduce_keyed(second_keyed),
    ))
}

fn mapped_pixel_key(first: u64, second: u64, bin_map: &[u32]) -> Result<u64> {
    let first = usize::try_from(first).map_err(|_| zoomify_error("bin1 exceeds usize"))?;
    let second = usize::try_from(second).map_err(|_| zoomify_error("bin2 exceeds usize"))?;
    let mapped_first = *bin_map
        .get(first)
        .ok_or_else(|| zoomify_error("pixel bin1 exceeds parent bin table"))?;
    let mapped_second = *bin_map
        .get(second)
        .ok_or_else(|| zoomify_error("pixel bin2 exceeds parent bin table"))?;
    if mapped_first > mapped_second {
        return Err(zoomify_error("coarsening broke symmetric-upper ordering"));
    }
    Ok((u64::from(mapped_first) << 32) | u64::from(mapped_second))
}

fn stable_reduce_keyed(mut keyed_counts: Vec<(u64, f64)>) -> AggregatedPixelChunk {
    // Stable sorting preserves source pixel order inside each coarse key, which
    // keeps floating-point aggregation deterministic across worker counts.
    keyed_counts.sort_by_key(|(key, _)| *key);
    let mut reduced: Vec<(u64, f64)> = Vec::with_capacity(keyed_counts.len());
    for (key, count) in keyed_counts {
        match reduced.last_mut() {
            Some((last_key, last_count)) if *last_key == key => *last_count += count,
            _ => reduced.push((key, count)),
        }
    }
    AggregatedPixelChunk {
        keyed_counts: reduced,
    }
}

impl PixelWriter {
    fn create(level: &Group, count_storage: CountStorage, compression_level: u8) -> Result<Self> {
        Self::create_with_buffer_elements(
            level,
            count_storage,
            PIXEL_WRITE_BUFFER_ELEMENTS,
            compression_level,
        )
    }

    fn create_with_buffer_elements(
        level: &Group,
        count_storage: CountStorage,
        buffer_elements: usize,
        compression_level: u8,
    ) -> Result<Self> {
        if buffer_elements == 0 || buffer_elements % PIXEL_DATASET_CHUNK != 0 {
            return Err(zoomify_error(format!(
                "pixel write buffer must be a non-zero multiple of the {PIXEL_DATASET_CHUNK}-element HDF5 chunk"
            )));
        }
        let pixels = level
            .create_group("pixels")
            .map_err(|error| zoomify_error(format!("failed to create pixels group: {error}")))?;
        validate_compression_level(compression_level)?;
        let bin1 = resizable_dataset::<i64>(&pixels, "bin1_id", compression_level)?;
        let bin2 = resizable_dataset::<i64>(&pixels, "bin2_id", compression_level)?;
        let counts = match count_storage {
            CountStorage::I32 => CountDataset::I32(resizable_dataset::<i32>(
                &pixels,
                "count",
                compression_level,
            )?),
            CountStorage::I64 => CountDataset::I64(resizable_dataset::<i64>(
                &pixels,
                "count",
                compression_level,
            )?),
            CountStorage::F64 => CountDataset::F64(resizable_dataset::<f64>(
                &pixels,
                "count",
                compression_level,
            )?),
        };
        Ok(Self {
            bin1,
            bin2,
            counts,
            written: 0,
            buffer: Vec::with_capacity(buffer_elements),
            buffer_elements,
            write_batches: 0,
        })
    }

    fn append(&mut self, mut pixels: &[(u64, f64)]) -> Result<()> {
        while !pixels.is_empty() {
            let remaining = self.buffer_elements - self.buffer.len();
            let take = remaining.min(pixels.len());
            self.buffer.extend_from_slice(&pixels[..take]);
            pixels = &pixels[take..];
            if self.buffer.len() == self.buffer_elements {
                self.flush_buffer()?;
            }
        }
        Ok(())
    }

    fn finish(mut self) -> Result<PixelWriterSummary> {
        let final_batch_pixels = self.buffer.len();
        self.flush_buffer()?;
        Ok(PixelWriterSummary {
            written: self.written,
            write_batches: self.write_batches,
            final_batch_pixels,
        })
    }

    fn flush_buffer(&mut self) -> Result<()> {
        if self.buffer.is_empty() {
            return Ok(());
        }
        let mut pixels = std::mem::take(&mut self.buffer);
        let result = self.write_pixels(&pixels);
        pixels.clear();
        self.buffer = pixels;
        result
    }

    fn write_pixels(&mut self, pixels: &[(u64, f64)]) -> Result<()> {
        enum PreparedCounts {
            I32(Vec<i32>),
            I64(Vec<i64>),
            F64(Vec<f64>),
        }

        let next_written = self
            .written
            .checked_add(pixels.len())
            .ok_or_else(|| zoomify_error("pixel dataset length overflowed"))?;
        let first = pixels
            .iter()
            .map(|(key, _)| i64::from((*key >> 32) as u32))
            .collect::<Vec<_>>();
        let second = pixels
            .iter()
            .map(|(key, _)| i64::from(*key as u32))
            .collect::<Vec<_>>();
        let counts = match &self.counts {
            CountDataset::I32(_) => PreparedCounts::I32(
                pixels
                    .iter()
                    .map(|(_, value)| exact_i32(*value))
                    .collect::<Result<Vec<_>>>()?,
            ),
            CountDataset::I64(_) => PreparedCounts::I64(
                pixels
                    .iter()
                    .map(|(_, value)| exact_i64(*value))
                    .collect::<Result<Vec<_>>>()?,
            ),
            CountDataset::F64(_) => {
                PreparedCounts::F64(pixels.iter().map(|(_, value)| *value).collect())
            }
        };
        append_dataset(&self.bin1, self.written, &first)?;
        append_dataset(&self.bin2, self.written, &second)?;
        match (&self.counts, counts) {
            (CountDataset::I32(dataset), PreparedCounts::I32(values)) => {
                append_dataset(dataset, self.written, &values)?
            }
            (CountDataset::I64(dataset), PreparedCounts::I64(values)) => {
                append_dataset(dataset, self.written, &values)?
            }
            (CountDataset::F64(dataset), PreparedCounts::F64(values)) => {
                append_dataset(dataset, self.written, &values)?
            }
            _ => {
                return Err(zoomify_error(
                    "prepared pixel count type changed unexpectedly",
                ))
            }
        }
        self.written = next_written;
        self.write_batches = self
            .write_batches
            .checked_add(1)
            .ok_or_else(|| zoomify_error("pixel writer batch count overflowed"))?;
        Ok(())
    }
}

fn resizable_dataset<T: H5Type>(
    group: &Group,
    name: &str,
    compression_level: u8,
) -> Result<Dataset> {
    group
        .new_dataset::<T>()
        .shape((0..,))
        .chunk((PIXEL_DATASET_CHUNK,))
        .shuffle()
        .deflate(compression_level)
        .create(name)
        .map_err(|error| zoomify_error(format!("failed to create pixels/{name}: {error}")))
}

fn append_dataset<T: H5Type>(dataset: &Dataset, offset: usize, values: &[T]) -> Result<()> {
    let end = offset
        .checked_add(values.len())
        .ok_or_else(|| zoomify_error("pixel dataset length overflowed"))?;
    dataset
        .resize((end,))
        .and_then(|_| dataset.write_slice(values, offset..end))
        .map_err(|error| zoomify_error(format!("failed to append pixel dataset: {error}")))
}

fn write_bin_table(
    level: &Group,
    chromosomes: &[i32],
    starts: &[u64],
    ends: &[u64],
    compression_level: u8,
) -> Result<()> {
    let bins = level
        .create_group("bins")
        .map_err(|error| zoomify_error(format!("failed to create bins group: {error}")))?;
    compressed_dataset(&bins, "chrom", chromosomes, compression_level)?;
    if ends.iter().copied().max().unwrap_or(0) <= i32::MAX as u64 {
        let starts = starts.iter().map(|value| *value as i32).collect::<Vec<_>>();
        let ends = ends.iter().map(|value| *value as i32).collect::<Vec<_>>();
        compressed_dataset(&bins, "start", &starts, compression_level)?;
        compressed_dataset(&bins, "end", &ends, compression_level)?;
    } else {
        let starts = starts.iter().map(|value| *value as i64).collect::<Vec<_>>();
        let ends = ends.iter().map(|value| *value as i64).collect::<Vec<_>>();
        compressed_dataset(&bins, "start", &starts, compression_level)?;
        compressed_dataset(&bins, "end", &ends, compression_level)?;
    }
    Ok(())
}

fn write_indexes(
    level: &Group,
    chrom_offsets: &[u64],
    bin1_offsets: &[u64],
    compression_level: u8,
) -> Result<()> {
    let indexes = level
        .create_group("indexes")
        .map_err(|error| zoomify_error(format!("failed to create indexes group: {error}")))?;
    let chrom_offsets = chrom_offsets
        .iter()
        .map(|value| i64::try_from(*value).map_err(|_| zoomify_error("chrom offset exceeds i64")))
        .collect::<Result<Vec<_>>>()?;
    let bin1_offsets = bin1_offsets
        .iter()
        .map(|value| i64::try_from(*value).map_err(|_| zoomify_error("bin1 offset exceeds i64")))
        .collect::<Result<Vec<_>>>()?;
    compressed_dataset(&indexes, "chrom_offset", &chrom_offsets, compression_level)?;
    compressed_dataset(&indexes, "bin1_offset", &bin1_offsets, compression_level)?;
    Ok(())
}

fn compressed_dataset<T: H5Type>(
    group: &Group,
    name: &str,
    values: &[T],
    compression_level: u8,
) -> Result<Dataset> {
    group
        .new_dataset_builder()
        .with_data(values)
        .shuffle()
        .deflate(compression_level)
        .create(name)
        .map_err(|error| zoomify_error(format!("failed to create {name}: {error}")))
}

fn prefix_offsets(row_counts: &[u64]) -> Result<Vec<u64>> {
    let mut offsets = Vec::with_capacity(row_counts.len() + 1);
    offsets.push(0_u64);
    for &count in row_counts {
        let next = offsets
            .last()
            .copied()
            .unwrap_or(0)
            .checked_add(count)
            .ok_or_else(|| zoomify_error("bin1 offsets overflowed u64"))?;
        offsets.push(next);
    }
    Ok(offsets)
}

fn count_storage(dataset: &Dataset) -> Result<CountStorage> {
    let dtype = dataset
        .dtype()
        .map_err(|error| zoomify_error(format!("failed to inspect count datatype: {error}")))?;
    if dtype.is::<i8>() || dtype.is::<i16>() || dtype.is::<i32>() {
        Ok(CountStorage::I32)
    } else if dtype.is::<u8>()
        || dtype.is::<u16>()
        || dtype.is::<u32>()
        || dtype.is::<i64>()
        || dtype.is::<u64>()
    {
        Ok(CountStorage::I64)
    } else if dtype.is::<f32>() || dtype.is::<f64>() {
        Ok(CountStorage::F64)
    } else {
        Err(zoomify_error(
            "pixels/count must be an integer or float dataset",
        ))
    }
}

fn exact_i32(value: f64) -> Result<i32> {
    if value.is_finite()
        && value.fract() == 0.0
        && value >= i32::MIN as f64
        && value <= i32::MAX as f64
    {
        Ok(value as i32)
    } else {
        Err(zoomify_error(format!(
            "aggregated count {value} cannot be stored as i32"
        )))
    }
}

fn exact_i64(value: f64) -> Result<i64> {
    if value.is_finite()
        && value.fract() == 0.0
        && value >= i64::MIN as f64
        && value <= i64::MAX as f64
    {
        Ok(value as i64)
    } else {
        Err(zoomify_error(format!(
            "aggregated count {value} cannot be stored as i64"
        )))
    }
}

fn write_level_attributes(
    parent: &Group,
    level: &Group,
    resolution: u64,
    chromosome_count: usize,
    bin_count: usize,
    pixel_count: usize,
    matrix_sum: f64,
) -> Result<()> {
    write_string_attr(level, "format", "HDF5::Cooler")?;
    write_string_attr(level, "format-url", "https://github.com/open2c/cooler")?;
    write_u64_attr(level, "format-version", 3)?;
    write_string_attr(level, "bin-type", "fixed")?;
    write_u64_attr(level, "bin-size", resolution)?;
    write_string_attr(level, "storage-mode", "symmetric-upper")?;
    write_string_attr(
        level,
        "generated-by",
        concat!("cool2mcool-", env!("CARGO_PKG_VERSION")),
    )?;
    for name in ["genome-assembly", "assembly", "metadata"] {
        if let Some(value) = optional_string_attr(parent, name)? {
            write_string_attr(level, name, &value)?;
        }
    }
    if !level
        .attr_names()
        .unwrap_or_default()
        .iter()
        .any(|name| name == "metadata")
    {
        write_string_attr(level, "metadata", "{}")?;
    }
    write_u64_attr(level, "nchroms", chromosome_count as u64)?;
    write_u64_attr(level, "nbins", bin_count as u64)?;
    write_u64_attr(level, "nnz", pixel_count as u64)?;
    write_f64_attr(level, "sum", matrix_sum)?;
    Ok(())
}

fn read_u64_dataset(dataset: &Dataset) -> Result<Vec<u64>> {
    dataset
        .read_1d::<u64>()
        .map(|values| values.to_vec())
        .map_err(|error| zoomify_error(format!("failed to read integer dataset: {error}")))
}

fn optional_string_attr(location: &Location, name: &str) -> Result<Option<String>> {
    let attribute = match location.attr(name) {
        Ok(attribute) => attribute,
        Err(_) => return Ok(None),
    };
    if let Ok(value) = attribute.read_scalar::<VarLenUnicode>() {
        return Ok(Some(value.as_str().to_string()));
    }
    if let Ok(value) = attribute.read_scalar::<hdf5::types::VarLenAscii>() {
        return Ok(Some(value.as_str().to_string()));
    }
    Err(zoomify_error(format!("attribute {name} is not a string")))
}

fn write_string_attr(location: &Location, name: &str, value: &str) -> Result<()> {
    if location.attr(name).is_ok() {
        location
            .attr(name)
            .and_then(|attribute| {
                let value = value.parse::<VarLenUnicode>().map_err(|error| {
                    hdf5::Error::Internal(format!("invalid UTF-8 attribute: {error}"))
                })?;
                attribute.write_scalar(&value)
            })
            .map_err(|error| zoomify_error(format!("failed to replace {name}: {error}")))?;
        return Ok(());
    }
    let value = value
        .parse::<VarLenUnicode>()
        .map_err(|error| zoomify_error(format!("invalid string attribute {name}: {error}")))?;
    location
        .new_attr::<VarLenUnicode>()
        .shape(())
        .create(name)
        .and_then(|attribute| attribute.write_scalar(&value))
        .map_err(|error| zoomify_error(format!("failed to write {name}: {error}")))
}

fn write_u64_attr(location: &Location, name: &str, value: u64) -> Result<()> {
    if let Ok(attribute) = location.attr(name) {
        return attribute
            .write_scalar(&value)
            .map_err(|error| zoomify_error(format!("failed to replace {name}: {error}")));
    }
    location
        .new_attr::<u64>()
        .shape(())
        .create(name)
        .and_then(|attribute| attribute.write_scalar(&value))
        .map_err(|error| zoomify_error(format!("failed to write {name}: {error}")))
}

fn write_f64_attr(location: &Location, name: &str, value: f64) -> Result<()> {
    if let Ok(attribute) = location.attr(name) {
        return attribute
            .write_scalar(&value)
            .map_err(|error| zoomify_error(format!("failed to replace {name}: {error}")));
    }
    location
        .new_attr::<f64>()
        .shape(())
        .create(name)
        .and_then(|attribute| attribute.write_scalar(&value))
        .map_err(|error| zoomify_error(format!("failed to write {name}: {error}")))
}

fn copy_object(
    source: hid_t,
    source_name: &str,
    destination: hid_t,
    destination_name: &str,
) -> Result<()> {
    let source_name = CString::new(source_name)
        .map_err(|_| zoomify_error("HDF5 source object name contains NUL"))?;
    let destination_name = CString::new(destination_name)
        .map_err(|_| zoomify_error("HDF5 destination object name contains NUL"))?;
    let status = hdf5::sync::sync(|| unsafe {
        H5Ocopy(
            source,
            source_name.as_ptr(),
            destination,
            destination_name.as_ptr(),
            H5P_DEFAULT,
            H5P_DEFAULT,
        )
    });
    if status < 0 {
        return Err(zoomify_error(format!(
            "failed to copy HDF5 object {source_name:?} to {destination_name:?}"
        )));
    }
    Ok(())
}

fn performance_logging_enabled() -> bool {
    std::env::var("COOL2MCOOL_PERF_LOG").as_deref() == Ok("1")
}

pub(crate) fn validate_compression_level(compression_level: u8) -> Result<()> {
    if (1..=MAX_COMPRESSION_LEVEL).contains(&compression_level) {
        Ok(())
    } else {
        Err(zoomify_error(format!(
            "compression level must be between 1 and {MAX_COMPRESSION_LEVEL}, found {compression_level}"
        )))
    }
}

fn zoomify_error(message: impl Into<String>) -> Error {
    Error::message(format!("native zoomify error: {}", message.into()))
}

#[cfg(test)]
mod tests {
    use super::{
        aggregate_chunk, aggregate_sibling_chunk, build_child_bins, build_work_spans,
        build_work_spans_for_factor, coarsen_performance_line, create_destination_file,
        open_source_file, prefix_offsets, resolution_jobs, resolution_work_batch, rust_zoomify,
        rust_zoomify_with_mode, rust_zoomify_with_mode_and_compression, write_string_attr,
        write_u64_attr, AggregationMode, CoarsenPhaseTimings, CountStorage, PixelWriter,
        RawPixelChunk, ResolutionJob, ResolutionWork, DEFAULT_COMPRESSION_LEVEL,
        DESTINATION_RAW_CHUNK_CACHE_BYTES, PIXEL_DATASET_CHUNK, PIXEL_WRITE_BUFFER_ELEMENTS,
        RAW_CHUNK_CACHE_SLOTS, RAW_CHUNK_CACHE_W0, SOURCE_RAW_CHUNK_CACHE_BYTES,
    };
    use hdf5::{filters::Filter, types::VarLenUnicode, File};
    use std::time::Duration;

    #[test]
    fn coarsen_performance_line_reports_phase_timings_and_counts() {
        let line = coarsen_performance_line(
            1_000,
            5_000,
            100,
            80,
            2,
            CoarsenPhaseTimings {
                read: Duration::from_millis(5),
                aggregate: Duration::from_millis(7),
                write: Duration::from_millis(11),
                read_pixels: 100,
                append_calls: 2,
                write_batches: 1,
                final_batch_pixels: 80,
                shared_read_targets: 1,
            },
            Duration::from_millis(31),
        );

        assert_eq!(
            line,
            "COOL2MCOOL_PERF event=rust_coarsen status=complete source_resolution=1000 resolution=5000 source_pixels=100 read_pixels=100 pixels=80 spans=2 shared_read_targets=1 append_calls=2 write_batches=1 final_batch_pixels=80 read_ms=5 aggregate_ms=7 write_ms=11 other_ms=8 elapsed_ms=31"
        );
    }

    #[test]
    fn zoomify_files_use_explicit_raw_chunk_caches() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let input = directory.path().join("input.cool");
        let output = directory.path().join("output.mcool");
        drop(File::create(&input).expect("input file"));

        let source = open_source_file(&input).expect("cached source file");
        let source_cache = source
            .access_plist()
            .expect("source access plist")
            .chunk_cache();
        assert_eq!(source_cache.nslots, RAW_CHUNK_CACHE_SLOTS);
        assert_eq!(source_cache.nbytes, SOURCE_RAW_CHUNK_CACHE_BYTES);
        assert_eq!(source_cache.w0, RAW_CHUNK_CACHE_W0);

        let destination = create_destination_file(&output).expect("cached destination file");
        let destination_cache = destination
            .access_plist()
            .expect("destination access plist")
            .chunk_cache();
        assert_eq!(destination_cache.nslots, RAW_CHUNK_CACHE_SLOTS);
        assert_eq!(destination_cache.nbytes, DESTINATION_RAW_CHUNK_CACHE_BYTES);
        assert_eq!(destination_cache.w0, RAW_CHUNK_CACHE_W0);
    }

    #[test]
    fn explicit_compression_api_rejects_invalid_levels_before_creating_output() {
        let directory = tempfile::tempdir().expect("temporary directory");
        for compression_level in [0, 10] {
            let output = directory
                .path()
                .join(format!("invalid-{compression_level}.mcool"));
            let error = rust_zoomify_with_mode_and_compression(
                &directory.path().join("missing.cool"),
                &output,
                &[5_000],
                1,
                1,
                AggregationMode::Pyramid,
                compression_level,
            )
            .expect_err("invalid compression level");
            assert!(error
                .to_string()
                .contains("compression level must be between"));
            assert!(!output.exists());
        }
    }

    #[test]
    fn pixel_writer_flushes_complete_chunks_and_finishes_the_tail() {
        assert_eq!(PIXEL_WRITE_BUFFER_ELEMENTS, 4 * PIXEL_DATASET_CHUNK);
        let directory = tempfile::tempdir().expect("temporary directory");
        let file = File::create(directory.path().join("writer.h5")).expect("writer file");
        let level = file.create_group("level").expect("level");
        let mut writer = PixelWriter::create_with_buffer_elements(
            &level,
            CountStorage::I32,
            PIXEL_DATASET_CHUNK,
            DEFAULT_COMPRESSION_LEVEL,
        )
        .expect("pixel writer");
        let pixels = (0..=PIXEL_DATASET_CHUNK)
            .map(|index| {
                let first = (index / 1_024) as u64;
                let second = (index % 1_024) as u64;
                ((first << 32) | second, index as f64)
            })
            .collect::<Vec<_>>();

        writer
            .append(&pixels[..PIXEL_DATASET_CHUNK - 1])
            .expect("first fragment");
        assert_eq!(level.dataset("pixels/bin1_id").expect("bin1").size(), 0);
        writer
            .append(&pixels[PIXEL_DATASET_CHUNK - 1..])
            .expect("cross-boundary fragment");
        assert_eq!(
            level.dataset("pixels/bin1_id").expect("bin1").size(),
            PIXEL_DATASET_CHUNK
        );

        let summary = writer.finish().expect("finish writer");
        assert_eq!(summary.written, PIXEL_DATASET_CHUNK + 1);
        assert_eq!(summary.write_batches, 2);
        assert_eq!(summary.final_batch_pixels, 1);
        let first = level
            .dataset("pixels/bin1_id")
            .expect("bin1")
            .read_1d::<i64>()
            .expect("read bin1")
            .to_vec();
        let second = level
            .dataset("pixels/bin2_id")
            .expect("bin2")
            .read_1d::<i64>()
            .expect("read bin2")
            .to_vec();
        let counts = level
            .dataset("pixels/count")
            .expect("counts")
            .read_1d::<i32>()
            .expect("read counts")
            .to_vec();
        assert_eq!(first.len(), pixels.len());
        assert_eq!(second.len(), pixels.len());
        assert_eq!(counts.len(), pixels.len());
        for (index, ((key, count), ((first, second), stored_count))) in pixels
            .iter()
            .zip(first.iter().zip(&second).zip(&counts))
            .enumerate()
        {
            assert_eq!(*first, i64::from((*key >> 32) as u32), "bin1 {index}");
            assert_eq!(*second, i64::from(*key as u32), "bin2 {index}");
            assert_eq!(*stored_count, *count as i32, "count {index}");
        }
    }

    #[test]
    fn pixel_writer_preserves_i64_and_f64_count_storage() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let file = File::create(directory.path().join("count-storage.h5")).expect("writer file");
        let i64_level = file.create_group("i64").expect("i64 level");
        let mut i64_writer =
            PixelWriter::create(&i64_level, CountStorage::I64, DEFAULT_COMPRESSION_LEVEL)
                .expect("i64 writer");
        i64_writer
            .append(&[(0, i32::MAX as f64 + 1.0), (1, -4.0)])
            .expect("append i64 counts");
        i64_writer.finish().expect("finish i64 writer");
        assert_eq!(
            i64_level
                .dataset("pixels/count")
                .expect("i64 counts")
                .read_1d::<i64>()
                .expect("read i64 counts")
                .to_vec(),
            vec![i64::from(i32::MAX) + 1, -4]
        );

        let f64_level = file.create_group("f64").expect("f64 level");
        let mut f64_writer =
            PixelWriter::create(&f64_level, CountStorage::F64, DEFAULT_COMPRESSION_LEVEL)
                .expect("f64 writer");
        f64_writer
            .append(&[(0, 1.25), (1, -4.5)])
            .expect("append f64 counts");
        f64_writer.finish().expect("finish f64 writer");
        assert_eq!(
            f64_level
                .dataset("pixels/count")
                .expect("f64 counts")
                .read_1d::<f64>()
                .expect("read f64 counts")
                .to_vec(),
            vec![1.25, -4.5]
        );
    }

    #[test]
    fn pixel_writer_propagates_tail_conversion_errors_before_writing() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let file = File::create(directory.path().join("invalid-count.h5")).expect("writer file");
        let level = file.create_group("level").expect("level");
        let mut writer = PixelWriter::create(&level, CountStorage::I32, DEFAULT_COMPRESSION_LEVEL)
            .expect("writer");
        writer.append(&[(0, 1.5)]).expect("buffer invalid count");
        let error = writer.finish().expect_err("fractional i32 must fail");
        assert!(error.to_string().contains("cannot be stored as i32"));
        assert_eq!(level.dataset("pixels/bin1_id").expect("bin1").size(), 0);
    }

    #[test]
    fn child_bins_restart_at_each_chromosome_and_keep_partial_ends() {
        let bins = build_child_bins(&[5_500, 2_000], 5_000).expect("child bins");
        assert_eq!(bins.chrom_offsets, vec![0, 2, 3]);
        assert_eq!(bins.chromosomes, vec![0, 0, 1]);
        assert_eq!(bins.starts, vec![0, 5_000, 0]);
        assert_eq!(bins.ends, vec![5_000, 5_500, 2_000]);
    }

    #[test]
    fn aggregation_maps_sorts_and_sums_duplicate_coarse_pixels() {
        let chunk = RawPixelChunk {
            bin1: vec![0, 0, 1, 1, 2],
            bin2: vec![0, 1, 1, 2, 2],
            counts: vec![1.0, 2.0, 3.0, 4.0, 5.0],
        };
        let result = aggregate_chunk(chunk, &[0, 0, 1]).expect("aggregate");
        assert_eq!(
            result.keyed_counts,
            vec![(0, 6.0), (1, 4.0), ((1_u64 << 32) | 1, 5.0)]
        );
    }

    #[test]
    fn sibling_aggregation_is_bitwise_identical_to_independent_targets() {
        let chunk = RawPixelChunk {
            bin1: vec![0, 0, 0, 1, 1, 2, 2, 3],
            bin2: vec![0, 1, 2, 1, 3, 2, 3, 3],
            counts: vec![1.0e16, 1.0, -1.0e16, 3.0, -0.0, 0.5, 0.25, 2.0],
        };
        let first_map = [0, 0, 1, 1];
        let second_map = [0, 0, 0, 0];
        let expected_first =
            aggregate_chunk(chunk.clone(), &first_map).expect("first independent target");
        let expected_second =
            aggregate_chunk(chunk.clone(), &second_map).expect("second independent target");
        let (observed_first, observed_second) =
            aggregate_sibling_chunk(chunk, &first_map, &second_map).expect("sibling targets");

        for (observed, expected) in [
            (observed_first, expected_first),
            (observed_second, expected_second),
        ] {
            assert_eq!(observed.keyed_counts.len(), expected.keyed_counts.len());
            for ((observed_key, observed_count), (expected_key, expected_count)) in
                observed.keyed_counts.iter().zip(&expected.keyed_counts)
            {
                assert_eq!(observed_key, expected_key);
                assert_eq!(observed_count.to_bits(), expected_count.to_bits());
            }
        }
    }

    #[test]
    fn work_spans_never_split_a_child_bin1_row() {
        let offsets = vec![0, 3, 8, 9, 20, 20];
        let spans = build_work_spans(&offsets, &[0, 5], &[0, 3], 2).expect("spans");
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].pixel_start, 0);
        assert_eq!(spans[0].pixel_end, 20);
    }

    #[test]
    fn shared_work_spans_only_cut_at_lcm_rows_or_chromosome_ends() {
        let row_pixels = 60_000_u64;
        let bin1_offsets = (0_u64..=34).map(|row| row * row_pixels).collect::<Vec<_>>();
        let spans = build_work_spans_for_factor(&bin1_offsets, &[0, 21, 34], 10)
            .expect("shared work spans");
        let row_boundaries = spans
            .iter()
            .flat_map(|span| [span.pixel_start, span.pixel_end])
            .map(|offset| offset / row_pixels as usize)
            .collect::<Vec<_>>();

        assert_eq!(row_boundaries, vec![0, 10, 10, 20, 20, 21, 21, 31, 31, 34]);
        assert!(row_boundaries
            .iter()
            .all(|row| matches!(*row, 0 | 10 | 20 | 21 | 31 | 34)));
    }

    #[test]
    fn pyramid_planner_fuses_only_eligible_same_parent_siblings() {
        let siblings = [
            ResolutionJob {
                parent: 5_000,
                resolution: 10_000,
            },
            ResolutionJob {
                parent: 5_000,
                resolution: 25_000,
            },
        ];
        assert_eq!(
            resolution_work_batch(&siblings, AggregationMode::Pyramid),
            vec![ResolutionWork::SiblingPair(siblings)]
        );
        assert_eq!(
            resolution_work_batch(&siblings[..1], AggregationMode::Pyramid),
            vec![ResolutionWork::Single(siblings[0])]
        );
        assert_eq!(
            resolution_work_batch(&siblings, AggregationMode::Direct),
            vec![
                ResolutionWork::Single(siblings[0]),
                ResolutionWork::Single(siblings[1]),
            ]
        );

        let excessive_lcm = [
            ResolutionJob {
                parent: 5_000,
                resolution: 15_000,
            },
            ResolutionJob {
                parent: 5_000,
                resolution: 25_000,
            },
        ];
        assert_eq!(
            resolution_work_batch(&excessive_lcm, AggregationMode::Pyramid),
            vec![
                ResolutionWork::Single(excessive_lcm[0]),
                ResolutionWork::Single(excessive_lcm[1]),
            ]
        );
    }

    #[test]
    fn prefix_offsets_include_empty_rows_and_terminal_nnz() {
        assert_eq!(
            prefix_offsets(&[2, 0, 3]).expect("offsets"),
            vec![0, 2, 2, 5]
        );
    }

    #[test]
    fn resolution_jobs_capture_independent_branches() {
        let jobs = resolution_jobs(
            &[
                1_000, 5_000, 10_000, 25_000, 50_000, 100_000, 250_000, 500_000, 1_000_000,
                2_000_000, 2_500_000,
            ],
            AggregationMode::Pyramid,
        )
        .expect("resolution jobs");
        assert_eq!(
            jobs,
            vec![
                ResolutionJob {
                    parent: 1_000,
                    resolution: 5_000,
                },
                ResolutionJob {
                    parent: 5_000,
                    resolution: 10_000,
                },
                ResolutionJob {
                    parent: 5_000,
                    resolution: 25_000,
                },
                ResolutionJob {
                    parent: 25_000,
                    resolution: 50_000,
                },
                ResolutionJob {
                    parent: 50_000,
                    resolution: 100_000,
                },
                ResolutionJob {
                    parent: 50_000,
                    resolution: 250_000,
                },
                ResolutionJob {
                    parent: 250_000,
                    resolution: 500_000,
                },
                ResolutionJob {
                    parent: 500_000,
                    resolution: 1_000_000,
                },
                ResolutionJob {
                    parent: 1_000_000,
                    resolution: 2_000_000,
                },
                ResolutionJob {
                    parent: 500_000,
                    resolution: 2_500_000,
                },
            ]
        );
    }

    #[test]
    fn resolution_jobs_use_the_input_when_the_1kb_level_is_omitted() {
        assert_eq!(
            resolution_jobs(&[5_000, 10_000], AggregationMode::Pyramid).expect("resolution jobs"),
            vec![
                ResolutionJob {
                    parent: 1_000,
                    resolution: 5_000,
                },
                ResolutionJob {
                    parent: 5_000,
                    resolution: 10_000,
                },
            ]
        );
    }

    #[test]
    fn direct_resolution_jobs_all_start_from_the_input() {
        assert_eq!(
            resolution_jobs(&[1_000, 5_000, 10_000, 25_000], AggregationMode::Direct)
                .expect("resolution jobs"),
            vec![
                ResolutionJob {
                    parent: 1_000,
                    resolution: 5_000,
                },
                ResolutionJob {
                    parent: 1_000,
                    resolution: 10_000,
                },
                ResolutionJob {
                    parent: 1_000,
                    resolution: 25_000,
                },
            ]
        );
    }

    #[test]
    fn native_zoomify_writes_a_complete_coarse_cooler_level() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let input = directory.path().join("input.cool");
        let serial_output = directory.path().join("serial.mcool");
        let parallel_output = directory.path().join("parallel.mcool");
        let direct_output = directory.path().join("direct.mcool");
        let level_six_output = directory.path().join("level-six.mcool");
        let file = File::create(&input).expect("input COOL");
        let chroms = file.create_group("chroms").expect("chroms");
        let chromosome = "chr1".parse::<VarLenUnicode>().expect("chromosome name");
        chroms
            .new_dataset_builder()
            .with_data(&[chromosome])
            .create("name")
            .expect("chrom names");
        chroms
            .new_dataset_builder()
            .with_data(&[2_500_i32])
            .create("length")
            .expect("chrom lengths");
        let bins = file.create_group("bins").expect("bins");
        bins.new_dataset_builder()
            .with_data(&[0_i32, 0, 0])
            .create("chrom")
            .expect("bin chromosomes");
        bins.new_dataset_builder()
            .with_data(&[0_i32, 1_000, 2_000])
            .create("start")
            .expect("bin starts");
        bins.new_dataset_builder()
            .with_data(&[1_000_i32, 2_000, 2_500])
            .create("end")
            .expect("bin ends");
        let pixels = file.create_group("pixels").expect("pixels");
        pixels
            .new_dataset_builder()
            .with_data(&[0_i64, 0, 0, 1, 1, 2])
            .create("bin1_id")
            .expect("pixel bin1");
        pixels
            .new_dataset_builder()
            .with_data(&[0_i64, 1, 2, 1, 2, 2])
            .create("bin2_id")
            .expect("pixel bin2");
        pixels
            .new_dataset_builder()
            .with_data(&[1_i32, 2, 3, 4, 5, 6])
            .create("count")
            .expect("pixel counts");
        let indexes = file.create_group("indexes").expect("indexes");
        indexes
            .new_dataset_builder()
            .with_data(&[0_i64, 3])
            .create("chrom_offset")
            .expect("chrom offsets");
        indexes
            .new_dataset_builder()
            .with_data(&[0_i64, 3, 5, 6])
            .create("bin1_offset")
            .expect("bin1 offsets");
        write_string_attr(&file, "format", "HDF5::Cooler").expect("format");
        write_u64_attr(&file, "format-version", 3).expect("format version");
        write_string_attr(&file, "bin-type", "fixed").expect("bin type");
        write_u64_attr(&file, "bin-size", 1_000).expect("bin size");
        write_string_attr(&file, "storage-mode", "symmetric-upper").expect("storage mode");
        file.flush().expect("flush input");
        drop(file);

        let resolutions = [2_000, 3_000, 6_000];
        rust_zoomify(&input, &serial_output, &resolutions, 4, 1).expect("serial native zoomify");
        rust_zoomify(&input, &parallel_output, &resolutions, 4, 2)
            .expect("parallel native zoomify");
        rust_zoomify_with_mode(
            &input,
            &direct_output,
            &resolutions,
            4,
            3,
            AggregationMode::Direct,
        )
        .expect("direct native zoomify");
        rust_zoomify_with_mode_and_compression(
            &input,
            &level_six_output,
            &resolutions,
            4,
            2,
            AggregationMode::Pyramid,
            6,
        )
        .expect("level-six native zoomify");
        let serial = File::open(&serial_output).expect("open serial output");
        let output = File::open(&parallel_output).expect("open parallel output");
        let direct = File::open(&direct_output).expect("open direct output");
        let level_six = File::open(&level_six_output).expect("open level-six output");
        for resolution in resolutions {
            for dataset in [
                "bins/chrom",
                "bins/start",
                "bins/end",
                "pixels/bin1_id",
                "pixels/bin2_id",
                "pixels/count",
                "indexes/chrom_offset",
                "indexes/bin1_offset",
            ] {
                let path = format!("resolutions/{resolution}/{dataset}");
                let serial_values = serial
                    .dataset(&path)
                    .expect("serial dataset")
                    .read_1d::<i64>()
                    .expect("read serial dataset")
                    .to_vec();
                let parallel_values = output
                    .dataset(&path)
                    .expect("parallel dataset")
                    .read_1d::<i64>()
                    .expect("read parallel dataset")
                    .to_vec();
                let direct_values = direct
                    .dataset(&path)
                    .expect("direct dataset")
                    .read_1d::<i64>()
                    .expect("read direct dataset")
                    .to_vec();
                let level_six_dataset = level_six.dataset(&path).expect("level-six dataset");
                let level_six_values = level_six_dataset
                    .read_1d::<i64>()
                    .expect("read level-six dataset")
                    .to_vec();
                assert_eq!(serial_values, parallel_values, "dataset {path}");
                assert_eq!(serial_values, direct_values, "direct dataset {path}");
                assert_eq!(serial_values, level_six_values, "level-six dataset {path}");
                assert_eq!(
                    output.dataset(&path).expect("parallel filter").filters(),
                    vec![Filter::Shuffle, Filter::Deflate(DEFAULT_COMPRESSION_LEVEL)],
                    "default compression filters for {path}"
                );
                assert_eq!(
                    level_six_dataset.filters(),
                    vec![Filter::Shuffle, Filter::Deflate(6)],
                    "level-six compression filters for {path}"
                );
            }
            for attribute in ["nchroms", "nbins", "nnz"] {
                let path = format!("resolutions/{resolution}");
                let expected = serial
                    .group(&path)
                    .expect("serial level")
                    .attr(attribute)
                    .expect("serial integer attribute")
                    .read_scalar::<u64>()
                    .expect("read serial integer attribute");
                for candidate in [&output, &direct, &level_six] {
                    assert_eq!(
                        candidate
                            .group(&path)
                            .expect("candidate level")
                            .attr(attribute)
                            .expect("candidate integer attribute")
                            .read_scalar::<u64>()
                            .expect("read candidate integer attribute"),
                        expected,
                        "attribute {path}/{attribute}"
                    );
                }
            }
            let path = format!("resolutions/{resolution}");
            let expected_sum = serial
                .group(&path)
                .expect("serial level")
                .attr("sum")
                .expect("serial sum")
                .read_scalar::<f64>()
                .expect("read serial sum")
                .to_bits();
            for candidate in [&output, &direct, &level_six] {
                assert_eq!(
                    candidate
                        .group(&path)
                        .expect("candidate level")
                        .attr("sum")
                        .expect("candidate sum")
                        .read_scalar::<f64>()
                        .expect("read candidate sum")
                        .to_bits(),
                    expected_sum,
                    "attribute {path}/sum"
                );
            }
        }
        assert!(output.group("resolutions/1000").is_err());
        assert!(direct.group("resolutions/1000").is_err());
        let level = output.group("resolutions/2000").expect("coarse level");
        assert_eq!(
            level
                .dataset("bins/start")
                .expect("starts")
                .read_1d::<i32>()
                .expect("read starts")
                .to_vec(),
            vec![0, 2_000]
        );
        assert_eq!(
            level
                .dataset("pixels/bin1_id")
                .expect("bin1")
                .read_1d::<i64>()
                .expect("read bin1")
                .to_vec(),
            vec![0, 0, 1]
        );
        assert_eq!(
            level
                .dataset("pixels/bin2_id")
                .expect("bin2")
                .read_1d::<i64>()
                .expect("read bin2")
                .to_vec(),
            vec![0, 1, 1]
        );
        assert_eq!(
            level
                .dataset("pixels/count")
                .expect("counts")
                .read_1d::<i32>()
                .expect("read counts")
                .to_vec(),
            vec![7, 8, 6]
        );
        assert_eq!(
            level
                .dataset("indexes/bin1_offset")
                .expect("offsets")
                .read_1d::<i64>()
                .expect("read offsets")
                .to_vec(),
            vec![0, 2, 3]
        );
    }
}
