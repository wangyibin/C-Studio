use crate::error::{Error, Result};
use rayon::{prelude::*, ThreadPool};

const NUMERIC_EPSILON: f64 = 1e-15;
const ICE_TOLERANCE: f64 = 1e-5;
const ICE_MAX_ITERATIONS: usize = 200;
const ICE_MIN_NONZERO_CONTACTS: usize = 10;
const ICE_MAD_MAX: f64 = 5.0;
const KR_TOLERANCE: f64 = 1e-6;
const KR_MAX_INNER_ITERATIONS: usize = 200;
const KR_MAX_STAGNANT_ITERATIONS: usize = 100;
const KR_STAGNANT_RESIDUAL_DELTA: f64 = 1e-6;
// Juicebox does not impose a matrix-vector-product ceiling; it stops after the
// residual ceases to improve. Keep a high defensive ceiling for malformed maps
// without cutting off valid large assembly matrices prematurely.
const KR_MAX_MATRIX_VECTOR_PRODUCTS: usize = 5_000;
const KR_MAX_RETRY_MATRIX_VECTOR_PRODUCTS: usize = 64;
const KR_WARM_START_LOG_DAMPING: f64 = 1.0;
const KR_WARM_START_MAX_LOG_MAGNITUDE: f64 = 18.420_680_743_952_367; // ln(1e8)
const KR_BOUNDARY_WARM_START_HUB_WEIGHT: f64 = 1e-16;
const KR_SUPPORT_PRUNE_MAX_ROUNDS: usize = 16;
const KR_WARM_START_PREBALANCE_ITERATIONS: usize = 16;
// Juicebox retries through 10%. Some whole-assembly matrices remain
// structurally unscalable at that support (POJ is one); continue to the
// smallest additional threshold that produces a finite global KR solution.
const KR_RETRY_PERCENTILES: [f64; 7] = [0.0, 1.0, 2.0, 3.0, 4.0, 10.0, 15.0];
const PARALLEL_MATRIX_ENTRY_THRESHOLD: usize = 250_000;
const PARALLEL_VECTOR_LENGTH_THRESHOLD: usize = 16_384;

fn run_in_pool<T: Send>(pool: Option<&ThreadPool>, operation: impl FnOnce() -> T + Send) -> T {
    match pool {
        Some(pool) => pool.install(operation),
        None => operation(),
    }
}

/// Contact-map normalization stored at every generated MCOOL resolution.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
pub enum Normalization {
    #[default]
    Raw,
    Ice,
    Kr,
    Vc,
    VcSqrt,
}

impl Normalization {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Raw => "raw",
            Self::Ice => "ice",
            Self::Kr => "kr",
            Self::Vc => "vc",
            Self::VcSqrt => "vc_sqrt",
        }
    }
}

/// Final ICE iterate plus its strict convergence status. Offline MCOOL
/// generation can persist a clearly annotated final iterate when an unusually
/// sparse coarse level cannot reach the runtime tolerance within its budget.
pub struct IceNormalizationResult {
    pub weights: Vec<f64>,
    pub converged: bool,
    pub relative_variance: f64,
}

/// Converged whole-assembly KR vector and the coverage percentile required to
/// obtain a scalable active support.
pub struct KrNormalizationResult {
    pub weights: Vec<f64>,
    pub coverage_percentile: f64,
}

/// All four stored vectors produced from one shared coverage pass and one
/// final matrix scan. The caller supplies the same bounded pool used by native
/// zoomification, so the pipeline never creates a nested normalization pool.
pub struct StoredNormalizationResults {
    pub ice: IceNormalizationResult,
    pub kr: KrNormalizationResult,
    pub vc: Vec<f64>,
    pub vc_sqrt: Vec<f64>,
}

/// One whole-assembly symmetric CSR shared by every normalization algorithm.
/// The source upper triangle is expanded once while it is streamed from HDF5;
/// no full COO copy is retained beside this matrix.
#[derive(Debug, Clone)]
pub struct SparseContactMatrix {
    bin_count: usize,
    source_pixel_count: usize,
    row_offsets: Vec<usize>,
    columns: Vec<u32>,
    counts: Vec<f64>,
}

impl SparseContactMatrix {
    pub(crate) fn bin_count(&self) -> usize {
        self.bin_count
    }
}

/// First pass of the bounded-memory symmetric CSR construction.
pub struct SymmetricCsrCounter {
    bin_count: usize,
    source_pixel_count: usize,
    row_lengths: Vec<usize>,
}

/// Second pass of the bounded-memory symmetric CSR construction.
pub struct SymmetricCsrBuilder {
    bin_count: usize,
    source_pixel_count: usize,
    row_offsets: Vec<usize>,
    next_row_entry: Vec<usize>,
    columns: Vec<u32>,
    counts: Vec<f64>,
}

/// Lightweight KR view over the shared CSR. Percentile retries only rebuild
/// active masks and never allocate another adjacency matrix.
struct GlobalKrMatrix<'a> {
    matrix: &'a SparseContactMatrix,
}

#[derive(Clone)]
struct ActiveKrSupport {
    /// Number of bins in the unfiltered global CSR.
    global_bin_count: usize,
    /// Compact active-vector position -> global bin.
    active_bins: Vec<u32>,
}

/// Active-only CSR used for the final, potentially long KR retry. Its rows and
/// columns use compact active-bin indexes, while `active_bins` retains the
/// stable mapping needed to expand the converged vector for MCOOL storage.
struct CompactKrMatrix {
    global_bin_count: usize,
    active_bins: Vec<u32>,
    row_offsets: Vec<usize>,
    columns: Vec<u32>,
    counts: Vec<f64>,
}

#[derive(Debug, Default)]
struct KrIterationStats {
    outer_iterations: usize,
    inner_iterations: usize,
    matrix_vector_products: usize,
    matrix_vector_product_nanos: u128,
}

enum KrBnewtOutcome {
    Converged(Vec<f64>),
    BudgetExhausted(Vec<f64>),
}

struct KrWarmStart {
    active_bins: Vec<u32>,
    weights: Vec<f64>,
}

impl KrWarmStart {
    fn for_support(&self, support: &ActiveKrSupport) -> Vec<f64> {
        debug_assert_eq!(self.active_bins.len(), self.weights.len());
        let mut initial = Vec::with_capacity(support.active_bins.len());
        let mut previous_index = 0_usize;

        for global_bin in support.active_bins.iter().copied() {
            while previous_index < self.active_bins.len()
                && self.active_bins[previous_index] < global_bin
            {
                previous_index += 1;
            }
            let weight = if previous_index < self.active_bins.len()
                && self.active_bins[previous_index] == global_bin
            {
                self.weights[previous_index]
            } else {
                1.0
            };
            initial.push(if weight.is_finite() && weight > 0.0 {
                weight
            } else {
                1.0
            });
        }

        initial
    }

    fn stabilized_for_support(&self, support: &ActiveKrSupport) -> Vec<f64> {
        let mut initial = self.for_support(support);
        stabilize_kr_initial_weights(&mut initial);
        initial
    }
}

fn stabilize_kr_initial_weights(weights: &mut [f64]) {
    if weights.is_empty() {
        return;
    }
    let mean_log = weights.iter().map(|weight| weight.ln()).sum::<f64>() / weights.len() as f64;
    for weight in weights {
        let centered_log = (weight.ln() - mean_log) * KR_WARM_START_LOG_DAMPING;
        *weight = centered_log
            .clamp(
                -KR_WARM_START_MAX_LOG_MAGNITUDE,
                KR_WARM_START_MAX_LOG_MAGNITUDE,
            )
            .exp();
    }
}

enum KrAttemptOutcome {
    Converged(Vec<f64>),
    BudgetExhausted(KrWarmStart),
}

trait KrMatrixOperator {
    fn size(&self) -> usize;
    fn kind(&self) -> &'static str;
    fn scratch_len(&self) -> usize;

    fn multiply_into(
        &self,
        vector: &[f64],
        scratch: &mut [f64],
        product: &mut [f64],
        pool: Option<&ThreadPool>,
        should_cancel: &dyn Fn() -> bool,
    ) -> Result<()>;

    fn multiply_in_place(
        &self,
        values: &mut [f64],
        scratch: &mut [f64],
        pool: Option<&ThreadPool>,
        should_cancel: &dyn Fn() -> bool,
    ) -> Result<()>;
}

struct ActiveGlobalKrMatrix<'a, 'matrix> {
    matrix: &'a GlobalKrMatrix<'matrix>,
    support: &'a ActiveKrSupport,
}

impl SymmetricCsrCounter {
    pub fn new(bin_count: usize, source_pixel_count: usize) -> Result<Self> {
        if bin_count > u32::MAX as usize {
            return Err(normalization_error(format!(
                "{bin_count} bins exceed the supported normalization index range",
            )));
        }
        Ok(Self {
            bin_count,
            source_pixel_count,
            row_lengths: vec![0; bin_count],
        })
    }

    pub fn count_pixel(
        &mut self,
        pixel_index: usize,
        first: u64,
        second: u64,
        count: f64,
    ) -> Result<()> {
        let (first, second) = validate_upper_pixel(
            self.bin_count,
            self.source_pixel_count,
            pixel_index,
            first,
            second,
        )?;
        if !count.is_finite() || count <= 0.0 {
            return Ok(());
        }
        self.row_lengths[first] = self.row_lengths[first]
            .checked_add(1)
            .ok_or_else(|| normalization_error("CSR row length overflowed"))?;
        if first != second {
            self.row_lengths[second] = self.row_lengths[second]
                .checked_add(1)
                .ok_or_else(|| normalization_error("CSR row length overflowed"))?;
        }
        Ok(())
    }

    pub fn into_builder(self) -> Result<SymmetricCsrBuilder> {
        let mut row_offsets = Vec::with_capacity(self.bin_count.saturating_add(1));
        row_offsets.push(0);
        for row_length in self.row_lengths {
            let next = row_offsets
                .last()
                .copied()
                .unwrap_or(0_usize)
                .checked_add(row_length)
                .ok_or_else(|| normalization_error("CSR entry count overflowed"))?;
            row_offsets.push(next);
        }
        let entry_count = row_offsets.last().copied().unwrap_or(0);
        Ok(SymmetricCsrBuilder {
            bin_count: self.bin_count,
            source_pixel_count: self.source_pixel_count,
            next_row_entry: row_offsets[..self.bin_count].to_vec(),
            row_offsets,
            columns: vec![0; entry_count],
            counts: vec![0.0; entry_count],
        })
    }
}

impl SymmetricCsrBuilder {
    pub fn push_pixel(
        &mut self,
        pixel_index: usize,
        first: u64,
        second: u64,
        count: f64,
    ) -> Result<()> {
        let (first, second) = validate_upper_pixel(
            self.bin_count,
            self.source_pixel_count,
            pixel_index,
            first,
            second,
        )?;
        if !count.is_finite() || count <= 0.0 {
            return Ok(());
        }
        self.write_entry(first, second, count)?;
        if first != second {
            self.write_entry(second, first, count)?;
        }
        Ok(())
    }

    fn write_entry(&mut self, row: usize, column: usize, count: f64) -> Result<()> {
        let entry = self.next_row_entry[row];
        if entry >= self.row_offsets[row + 1] {
            return Err(normalization_error(format!(
                "CSR row {row} received more entries than the first pass counted",
            )));
        }
        self.columns[entry] = column as u32;
        self.counts[entry] = count;
        self.next_row_entry[row] += 1;
        Ok(())
    }

    pub fn finish(self) -> Result<SparseContactMatrix> {
        if self
            .next_row_entry
            .iter()
            .zip(&self.row_offsets[1..])
            .any(|(observed, expected)| observed != expected)
        {
            return Err(normalization_error(
                "CSR second pass did not fill every counted entry",
            ));
        }
        Ok(SparseContactMatrix {
            bin_count: self.bin_count,
            source_pixel_count: self.source_pixel_count,
            row_offsets: self.row_offsets,
            columns: self.columns,
            counts: self.counts,
        })
    }
}

fn validate_upper_pixel(
    bin_count: usize,
    source_pixel_count: usize,
    pixel_index: usize,
    first: u64,
    second: u64,
) -> Result<(usize, usize)> {
    if pixel_index >= source_pixel_count {
        return Err(normalization_error(format!(
            "pixel index {pixel_index} exceeds the declared {source_pixel_count} pixels",
        )));
    }
    if first >= bin_count as u64 || second >= bin_count as u64 {
        return Err(normalization_error(format!(
            "pixel {pixel_index} references bin ({first}, {second}) outside {bin_count} bins",
        )));
    }
    if first > second {
        return Err(normalization_error(format!(
            "pixel {pixel_index} is below the symmetric-upper triangle: ({first}, {second})",
        )));
    }
    Ok((first as usize, second as usize))
}

impl<'a> GlobalKrMatrix<'a> {
    fn from_sparse(
        matrix: &'a SparseContactMatrix,
        should_cancel: &dyn Fn() -> bool,
    ) -> Result<Self> {
        ensure_not_cancelled(should_cancel)?;
        if std::env::var("COOL2MCOOL_PERF_LOG").as_deref() == Ok("1") {
            eprintln!(
                "COOL2MCOOL_PERF event=kr_global_csr status=reused bins={} source_pixels={} symmetric_entries={}",
                matrix.bin_count,
                matrix.source_pixel_count,
                matrix.counts.len(),
            );
        }
        Ok(Self { matrix })
    }

    fn active_support(
        &self,
        coverage: &[f64],
        coverage_threshold: f64,
        pool: Option<&ThreadPool>,
        should_cancel: &dyn Fn() -> bool,
    ) -> Result<ActiveKrSupport> {
        if coverage.len() + 1 != self.row_offsets.len() {
            return Err(normalization_error(
                "KR coverage and global CSR have different bin counts",
            ));
        }
        ensure_not_cancelled(should_cancel)?;
        let mut active = run_in_pool(pool, || {
            coverage
                .par_iter()
                .map(|value| u8::from(value.is_finite() && *value > coverage_threshold))
                .collect::<Vec<_>>()
        });
        for _ in 0..KR_SUPPORT_PRUNE_MAX_ROUNDS {
            let degrees = run_in_pool(pool, || {
                (0..coverage.len())
                    .into_par_iter()
                    .map(|row| {
                        if active[row] == 0 {
                            return 0_u32;
                        }
                        (self.row_offsets[row]..self.row_offsets[row + 1])
                            .filter(|entry| active[self.columns[*entry] as usize] != 0)
                            .count() as u32
                    })
                    .collect::<Vec<_>>()
            });
            let refined = run_in_pool(pool, || {
                (0..coverage.len())
                    .into_par_iter()
                    .map(|row| {
                        let degree = degrees[row];
                        if active[row] == 0 || degree == 0 {
                            return 0_u8;
                        }
                        if degree >= 2 {
                            return 1_u8;
                        }
                        let neighbor = (self.row_offsets[row]..self.row_offsets[row + 1])
                            .map(|entry| self.columns[entry] as usize)
                            .find(|column| active[*column] != 0)
                            .expect("a degree-one KR candidate has one active neighbor");
                        // A self-loop and an isolated two-bin pair are directly
                        // scalable. A degree-one leaf attached to a higher-degree
                        // hub is not: its row equation consumes the hub's entire
                        // unit marginal and forces all other hub edges to zero.
                        u8::from(neighbor == row || degrees[neighbor] == 1)
                    })
                    .collect::<Vec<_>>()
            });
            let changed = run_in_pool(pool, || {
                active
                    .par_iter()
                    .zip(refined.par_iter())
                    .any(|(old, new)| old != new)
            });
            active = refined;
            if !changed {
                break;
            }
        }
        ensure_not_cancelled(should_cancel)?;

        let active_bins = run_in_pool(pool, || {
            active
                .par_iter()
                .enumerate()
                .filter_map(|(bin, is_active)| (*is_active != 0).then_some(bin as u32))
                .collect::<Vec<_>>()
        });
        Ok(ActiveKrSupport {
            global_bin_count: active.len(),
            active_bins,
        })
    }

    fn multiply_active_into(
        &self,
        support: &ActiveKrSupport,
        vector: &[f64],
        expanded_vector: &mut [f64],
        product: &mut [f64],
        pool: Option<&ThreadPool>,
        should_cancel: &dyn Fn() -> bool,
    ) -> Result<()> {
        if product.len() != vector.len()
            || support.active_bins.len() != vector.len()
            || support.global_bin_count + 1 != self.row_offsets.len()
            || expanded_vector.len() + 1 != self.row_offsets.len()
        {
            return Err(normalization_error(
                "KR matrix product buffer has the wrong length",
            ));
        }
        ensure_not_cancelled(should_cancel)?;
        expanded_vector.fill(0.0);
        for (compact_bin, global_bin) in support.active_bins.iter().copied().enumerate() {
            expanded_vector[global_bin as usize] = vector[compact_bin];
        }
        let multiply_row = |row: usize| {
            let mut sum = 0.0;
            let global_row = support.active_bins[row] as usize;
            for entry in self.row_offsets[global_row]..self.row_offsets[global_row + 1] {
                sum += self.counts[entry] * expanded_vector[self.columns[entry] as usize];
            }
            sum
        };
        if self.counts.len() >= PARALLEL_MATRIX_ENTRY_THRESHOLD {
            run_in_pool(pool, || {
                product
                    .par_iter_mut()
                    .enumerate()
                    .for_each(|(row, value)| *value = multiply_row(row));
            });
        } else {
            for (row, value) in product.iter_mut().enumerate() {
                *value = multiply_row(row);
            }
        }
        ensure_not_cancelled(should_cancel)
    }

    fn multiply_active_in_place(
        &self,
        support: &ActiveKrSupport,
        values: &mut [f64],
        expanded_vector: &mut [f64],
        pool: Option<&ThreadPool>,
        should_cancel: &dyn Fn() -> bool,
    ) -> Result<()> {
        if support.active_bins.len() != values.len()
            || support.global_bin_count + 1 != self.row_offsets.len()
            || expanded_vector.len() + 1 != self.row_offsets.len()
        {
            return Err(normalization_error(
                "KR in-place matrix product buffer has the wrong length",
            ));
        }
        ensure_not_cancelled(should_cancel)?;
        expanded_vector.fill(0.0);
        for (compact_bin, global_bin) in support.active_bins.iter().copied().enumerate() {
            expanded_vector[global_bin as usize] = values[compact_bin];
        }
        let multiply_row = |row: usize| {
            let mut sum = 0.0;
            let global_row = support.active_bins[row] as usize;
            for entry in self.row_offsets[global_row]..self.row_offsets[global_row + 1] {
                sum += self.counts[entry] * expanded_vector[self.columns[entry] as usize];
            }
            sum
        };
        if self.counts.len() >= PARALLEL_MATRIX_ENTRY_THRESHOLD {
            run_in_pool(pool, || {
                values
                    .par_iter_mut()
                    .enumerate()
                    .for_each(|(row, value)| *value = multiply_row(row));
            });
        } else {
            for (row, value) in values.iter_mut().enumerate() {
                *value = multiply_row(row);
            }
        }
        ensure_not_cancelled(should_cancel)
    }
}

impl KrMatrixOperator for ActiveGlobalKrMatrix<'_, '_> {
    fn size(&self) -> usize {
        self.support.active_bins.len()
    }

    fn kind(&self) -> &'static str {
        "global"
    }

    fn scratch_len(&self) -> usize {
        self.support.global_bin_count
    }

    fn multiply_into(
        &self,
        vector: &[f64],
        scratch: &mut [f64],
        product: &mut [f64],
        pool: Option<&ThreadPool>,
        should_cancel: &dyn Fn() -> bool,
    ) -> Result<()> {
        self.matrix.multiply_active_into(
            self.support,
            vector,
            scratch,
            product,
            pool,
            should_cancel,
        )
    }

    fn multiply_in_place(
        &self,
        values: &mut [f64],
        scratch: &mut [f64],
        pool: Option<&ThreadPool>,
        should_cancel: &dyn Fn() -> bool,
    ) -> Result<()> {
        self.matrix
            .multiply_active_in_place(self.support, values, scratch, pool, should_cancel)
    }
}

impl SparseContactMatrix {
    fn into_compact_kr(
        self,
        support: ActiveKrSupport,
        should_cancel: &dyn Fn() -> bool,
    ) -> Result<CompactKrMatrix> {
        if support.global_bin_count != self.bin_count || support.active_bins.len() > self.bin_count
        {
            return Err(normalization_error(
                "KR active support does not match the global CSR",
            ));
        }
        ensure_not_cancelled(should_cancel)?;
        let compact_started = std::time::Instant::now();

        let SparseContactMatrix {
            bin_count,
            source_pixel_count: _,
            row_offsets,
            mut columns,
            mut counts,
        } = self;
        let original_entry_count = counts.len();
        let mut global_to_compact = vec![u32::MAX; bin_count];
        for (compact_bin, global_bin) in support.active_bins.iter().copied().enumerate() {
            let global_bin = global_bin as usize;
            if global_bin >= bin_count || global_to_compact[global_bin] != u32::MAX {
                return Err(normalization_error(
                    "KR active support contains an invalid or duplicate bin",
                ));
            }
            global_to_compact[global_bin] = compact_bin as u32;
        }

        // Preserve each active row's original entry order while overwriting the
        // front of the existing column/count allocations. This avoids holding
        // global and compact adjacency buffers at the same time.
        let mut compact_row_offsets = Vec::with_capacity(support.active_bins.len() + 1);
        compact_row_offsets.push(0);
        let mut write_entry = 0_usize;
        for (compact_row, global_row) in support.active_bins.iter().copied().enumerate() {
            if compact_row % 16_384 == 0 {
                ensure_not_cancelled(should_cancel)?;
            }
            let global_row = global_row as usize;
            for read_entry in row_offsets[global_row]..row_offsets[global_row + 1] {
                let compact_column = global_to_compact[columns[read_entry] as usize];
                if compact_column == u32::MAX {
                    continue;
                }
                columns[write_entry] = compact_column;
                counts[write_entry] = counts[read_entry];
                write_entry += 1;
            }
            compact_row_offsets.push(write_entry);
        }
        columns.truncate(write_entry);
        counts.truncate(write_entry);
        drop(global_to_compact);
        drop(row_offsets);
        ensure_not_cancelled(should_cancel)?;

        if std::env::var("COOL2MCOOL_PERF_LOG").as_deref() == Ok("1") {
            eprintln!(
                "COOL2MCOOL_PERF event=kr_compact_csr status=complete global_bins={} active_bins={} global_entries={} compact_entries={} retained_percent={:.3} reused_storage=true elapsed_ms={}",
                bin_count,
                support.active_bins.len(),
                original_entry_count,
                write_entry,
                write_entry as f64 * 100.0 / original_entry_count.max(1) as f64,
                compact_started.elapsed().as_millis(),
            );
        }

        Ok(CompactKrMatrix {
            global_bin_count: bin_count,
            active_bins: support.active_bins,
            row_offsets: compact_row_offsets,
            columns,
            counts,
        })
    }
}

impl CompactKrMatrix {
    fn multiply_rows(
        &self,
        vector: &[f64],
        product: &mut [f64],
        pool: Option<&ThreadPool>,
        should_cancel: &dyn Fn() -> bool,
    ) -> Result<()> {
        if vector.len() != self.active_bins.len() || product.len() != self.active_bins.len() {
            return Err(normalization_error(
                "compact KR matrix product buffer has the wrong length",
            ));
        }
        ensure_not_cancelled(should_cancel)?;
        let multiply_row = |row: usize| {
            let mut sum = 0.0;
            for entry in self.row_offsets[row]..self.row_offsets[row + 1] {
                sum += self.counts[entry] * vector[self.columns[entry] as usize];
            }
            sum
        };
        if self.counts.len() >= PARALLEL_MATRIX_ENTRY_THRESHOLD {
            run_in_pool(pool, || {
                product
                    .par_iter_mut()
                    .enumerate()
                    .for_each(|(row, value)| *value = multiply_row(row));
            });
        } else {
            for (row, value) in product.iter_mut().enumerate() {
                *value = multiply_row(row);
            }
        }
        ensure_not_cancelled(should_cancel)
    }

    fn rescale_weights_to_preserve_total(
        &self,
        weights: &mut [f64],
        should_cancel: &dyn Fn() -> bool,
    ) -> Result<()> {
        let mut raw_sum = 0.0;
        let mut normalized_sum = 0.0;
        for first in 0..self.active_bins.len() {
            if first % 16_384 == 0 {
                ensure_not_cancelled(should_cancel)?;
            }
            for entry in self.row_offsets[first]..self.row_offsets[first + 1] {
                let second = self.columns[entry] as usize;
                if second < first {
                    continue;
                }
                let first_weight = weights[first];
                let second_weight = weights[second];
                let count = self.counts[entry];
                if !count.is_finite()
                    || count <= 0.0
                    || !first_weight.is_finite()
                    || first_weight <= 0.0
                    || !second_weight.is_finite()
                    || second_weight <= 0.0
                {
                    continue;
                }
                let symmetry = if first == second { 1.0 } else { 2.0 };
                raw_sum += symmetry * count;
                normalized_sum += symmetry * count * first_weight * second_weight;
            }
        }
        if raw_sum <= 0.0 || normalized_sum <= 0.0 {
            return Ok(());
        }
        let scale = (raw_sum / normalized_sum).sqrt();
        if !scale.is_finite() || scale <= 0.0 {
            return Err(normalization_error(
                "compact KR total-preserving scale is non-finite",
            ));
        }
        for weight in weights {
            if weight.is_finite() && *weight > 0.0 {
                *weight *= scale;
            }
        }
        Ok(())
    }

    fn expand_weights(&self, compact: Vec<f64>) -> Vec<f64> {
        let mut weights = vec![f64::NAN; self.global_bin_count];
        for (compact_index, global_bin) in self.active_bins.iter().copied().enumerate() {
            let value = compact[compact_index];
            if value.is_finite() && value > 0.0 {
                weights[global_bin as usize] = value;
            }
        }
        weights
    }
}

impl KrMatrixOperator for CompactKrMatrix {
    fn size(&self) -> usize {
        self.active_bins.len()
    }

    fn kind(&self) -> &'static str {
        "compact"
    }

    fn scratch_len(&self) -> usize {
        self.active_bins.len()
    }

    fn multiply_into(
        &self,
        vector: &[f64],
        _scratch: &mut [f64],
        product: &mut [f64],
        pool: Option<&ThreadPool>,
        should_cancel: &dyn Fn() -> bool,
    ) -> Result<()> {
        self.multiply_rows(vector, product, pool, should_cancel)
    }

    fn multiply_in_place(
        &self,
        values: &mut [f64],
        scratch: &mut [f64],
        pool: Option<&ThreadPool>,
        should_cancel: &dyn Fn() -> bool,
    ) -> Result<()> {
        if scratch.len() != values.len() {
            return Err(normalization_error(
                "compact KR scratch buffer has the wrong length",
            ));
        }
        scratch.copy_from_slice(values);
        self.multiply_rows(scratch, values, pool, should_cancel)
    }
}

impl std::ops::Deref for GlobalKrMatrix<'_> {
    type Target = SparseContactMatrix;

    fn deref(&self) -> &Self::Target {
        self.matrix
    }
}

impl SparseContactMatrix {
    pub fn new(bin_count: usize, bin1: Vec<u64>, bin2: Vec<u64>, counts: Vec<f64>) -> Result<Self> {
        if bin1.len() != bin2.len() || bin1.len() != counts.len() {
            return Err(normalization_error(
                "pixel bin1, bin2, and count arrays have different lengths",
            ));
        }
        let source_pixel_count = counts.len();
        let mut counter = SymmetricCsrCounter::new(bin_count, source_pixel_count)?;
        for pixel_index in 0..source_pixel_count {
            counter.count_pixel(
                pixel_index,
                bin1[pixel_index],
                bin2[pixel_index],
                counts[pixel_index],
            )?;
        }
        let mut builder = counter.into_builder()?;
        for pixel_index in 0..source_pixel_count {
            builder.push_pixel(
                pixel_index,
                bin1[pixel_index],
                bin2[pixel_index],
                counts[pixel_index],
            )?;
        }
        builder.finish()
    }

    fn row_sums(&self, should_cancel: &dyn Fn() -> bool) -> Result<Vec<f64>> {
        self.row_sums_with_pool(None, should_cancel)
    }

    fn row_sums_with_pool(
        &self,
        pool: Option<&ThreadPool>,
        should_cancel: &dyn Fn() -> bool,
    ) -> Result<Vec<f64>> {
        ensure_not_cancelled(should_cancel)?;
        let sum_row = |row: usize| {
            let mut sum = 0.0;
            for entry in self.row_offsets[row]..self.row_offsets[row + 1] {
                sum += self.counts[entry];
            }
            sum
        };
        let sums = if self.counts.len() >= PARALLEL_MATRIX_ENTRY_THRESHOLD {
            run_in_pool(pool, || {
                (0..self.bin_count)
                    .into_par_iter()
                    .map(sum_row)
                    .collect::<Vec<_>>()
            })
        } else {
            (0..self.bin_count).map(sum_row).collect::<Vec<_>>()
        };
        ensure_not_cancelled(should_cancel)?;
        Ok(sums)
    }

    fn row_nonzero_counts(&self, should_cancel: &dyn Fn() -> bool) -> Result<Vec<usize>> {
        ensure_not_cancelled(should_cancel)?;
        Ok((0..self.bin_count)
            .map(|row| self.row_offsets[row + 1] - self.row_offsets[row])
            .collect())
    }

    #[cfg(test)]
    fn multiply(&self, vector: &[f64], should_cancel: &dyn Fn() -> bool) -> Result<Vec<f64>> {
        let mut product = vec![0.0; self.bin_count];
        self.multiply_into(vector, &mut product, None, should_cancel)?;
        Ok(product)
    }

    fn multiply_into(
        &self,
        vector: &[f64],
        product: &mut [f64],
        pool: Option<&ThreadPool>,
        should_cancel: &dyn Fn() -> bool,
    ) -> Result<()> {
        if vector.len() != self.bin_count {
            return Err(normalization_error(format!(
                "matrix vector has {} entries for {} bins",
                vector.len(),
                self.bin_count,
            )));
        }
        if product.len() != self.bin_count {
            return Err(normalization_error(format!(
                "matrix product has {} entries for {} bins",
                product.len(),
                self.bin_count,
            )));
        }
        ensure_not_cancelled(should_cancel)?;
        let multiply_row = |row: usize| {
            let mut sum = 0.0;
            for entry in self.row_offsets[row]..self.row_offsets[row + 1] {
                sum += self.counts[entry]
                    * finite_positive_or_zero(vector[self.columns[entry] as usize]);
            }
            sum
        };
        if self.counts.len() >= PARALLEL_MATRIX_ENTRY_THRESHOLD {
            run_in_pool(pool, || {
                product
                    .par_iter_mut()
                    .enumerate()
                    .for_each(|(row, value)| *value = multiply_row(row));
            });
        } else {
            for (row, value) in product.iter_mut().enumerate() {
                *value = multiply_row(row);
            }
        }
        ensure_not_cancelled(should_cancel)?;
        Ok(())
    }

    fn for_each_positive_pixel(
        &self,
        should_cancel: &dyn Fn() -> bool,
        mut visit: impl FnMut(usize, usize, f64),
    ) -> Result<()> {
        ensure_not_cancelled(should_cancel)?;
        let mut visited_entries = 0_usize;
        for first in 0..self.bin_count {
            for entry in self.row_offsets[first]..self.row_offsets[first + 1] {
                if visited_entries % 16_384 == 0 {
                    ensure_not_cancelled(should_cancel)?;
                }
                visited_entries += 1;
                let second = self.columns[entry] as usize;
                if second < first {
                    continue;
                }
                let count = self.counts[entry];
                if count.is_finite() && count > 0.0 {
                    visit(first, second, count);
                }
            }
            if first % 16_384 == 0 {
                ensure_not_cancelled(should_cancel)?;
            }
        }
        ensure_not_cancelled(should_cancel)
    }
}

/// Calculate one global multiplicative vector (`Nij = Oij * wi * wj`).
pub fn compute_normalization_weights(
    matrix: &SparseContactMatrix,
    normalization: Normalization,
    should_cancel: &dyn Fn() -> bool,
) -> Result<Vec<f64>> {
    ensure_not_cancelled(should_cancel)?;
    match normalization {
        Normalization::Raw => Ok(vec![1.0; matrix.bin_count]),
        Normalization::Vc => coverage_weights(matrix, false, should_cancel),
        Normalization::VcSqrt => coverage_weights(matrix, true, should_cancel),
        Normalization::Ice => ice_weights(matrix, should_cancel),
        Normalization::Kr => {
            compute_kr_weights_for_storage(matrix, should_cancel).map(|result| result.weights)
        }
    }
}

/// Calculate VC or VC_SQRT independently from each chromosome's cis contacts.
/// This matches the runtime fallback used by C-Studio while avoiding one local
/// sparse-matrix allocation per chromosome during MCOOL generation.
pub fn compute_cis_coverage_normalization_weights(
    matrix: &SparseContactMatrix,
    bin_chrom_ids: &[u32],
    chromosome_count: usize,
    normalization: Normalization,
    should_cancel: &dyn Fn() -> bool,
) -> Result<Vec<f64>> {
    let square_root = match normalization {
        Normalization::Vc => false,
        Normalization::VcSqrt => true,
        _ => {
            return Err(normalization_error(
                "chromosome-cis coverage calculation only supports VC and VC_SQRT",
            ));
        }
    };
    if bin_chrom_ids.len() != matrix.bin_count {
        return Err(normalization_error(format!(
            "bin chromosome index has {} entries for {} bins",
            bin_chrom_ids.len(),
            matrix.bin_count,
        )));
    }
    if bin_chrom_ids
        .iter()
        .any(|chromosome| *chromosome as usize >= chromosome_count)
    {
        return Err(normalization_error(
            "bin chromosome index exceeds the chromosome table",
        ));
    }

    let mut coverage = vec![0.0; matrix.bin_count];
    matrix.for_each_positive_pixel(should_cancel, |first, second, count| {
        if bin_chrom_ids[first] != bin_chrom_ids[second] {
            return;
        }
        coverage[first] += count;
        if first != second {
            coverage[second] += count;
        }
    })?;
    let mut weights = coverage
        .into_iter()
        .map(|value| {
            if !value.is_finite() || value <= 0.0 {
                f64::NAN
            } else if square_root {
                1.0 / value.sqrt()
            } else {
                1.0 / value
            }
        })
        .collect::<Vec<_>>();

    let mut raw_sums = vec![0.0; chromosome_count];
    let mut normalized_sums = vec![0.0; chromosome_count];
    matrix.for_each_positive_pixel(should_cancel, |first, second, count| {
        let chromosome = bin_chrom_ids[first] as usize;
        if chromosome != bin_chrom_ids[second] as usize {
            return;
        }
        let first_weight = weights[first];
        let second_weight = weights[second];
        if !first_weight.is_finite()
            || first_weight <= 0.0
            || !second_weight.is_finite()
            || second_weight <= 0.0
        {
            return;
        }
        let symmetry = if first == second { 1.0 } else { 2.0 };
        raw_sums[chromosome] += symmetry * count;
        normalized_sums[chromosome] += symmetry * count * first_weight * second_weight;
    })?;
    let scales = raw_sums
        .into_iter()
        .zip(normalized_sums)
        .map(|(raw_sum, normalized_sum)| {
            if raw_sum > 0.0 && normalized_sum > 0.0 {
                (raw_sum / normalized_sum).sqrt()
            } else {
                1.0
            }
        })
        .collect::<Vec<_>>();
    for (bin, weight) in weights.iter_mut().enumerate() {
        if weight.is_finite() && *weight > 0.0 {
            *weight *= scales[bin_chrom_ids[bin] as usize];
        }
    }
    Ok(weights)
}

/// Compute every stored normalization from one global coverage vector, one cis
/// coverage vector, and one final upper-triangle scan. Element-wise row work is
/// installed on the caller's bounded worker pool; scalar reductions retain
/// their original row and pixel order.
pub fn compute_stored_normalizations_with_pool(
    matrix: &SparseContactMatrix,
    bin_chrom_ids: &[u32],
    chromosome_count: usize,
    pool: &ThreadPool,
    should_cancel: &dyn Fn() -> bool,
    mut started: impl FnMut(Normalization),
) -> Result<StoredNormalizationResults> {
    validate_bin_chromosomes(matrix, bin_chrom_ids, chromosome_count)?;
    let perf_enabled = std::env::var("COOL2MCOOL_PERF_LOG").as_deref() == Ok("1");

    let phase_started = std::time::Instant::now();
    let coverage = matrix.row_sums_with_pool(Some(pool), should_cancel)?;
    if perf_enabled {
        eprintln!(
            "COOL2MCOOL_PERF event=normalization_coverage status=complete bins={} source_pixels={} elapsed_ms={}",
            matrix.bin_count,
            matrix.source_pixel_count,
            phase_started.elapsed().as_millis(),
        );
    }

    started(Normalization::Ice);
    let phase_started = std::time::Instant::now();
    let mut ice =
        compute_ice_weights_from_coverage(matrix, &coverage, Some(pool), false, should_cancel)?;
    if perf_enabled {
        eprintln!(
            "COOL2MCOOL_PERF event=normalization_ice status=complete bins={} elapsed_ms={}",
            matrix.bin_count,
            phase_started.elapsed().as_millis(),
        );
    }

    started(Normalization::Kr);
    let phase_started = std::time::Instant::now();
    let mut kr =
        compute_kr_weights_from_coverage(matrix, &coverage, Some(pool), false, should_cancel)?;
    if perf_enabled {
        eprintln!(
            "COOL2MCOOL_PERF event=normalization_kr status=complete bins={} elapsed_ms={}",
            matrix.bin_count,
            phase_started.elapsed().as_millis(),
        );
    }

    started(Normalization::Vc);
    let phase_started = std::time::Instant::now();
    let cis_coverage = chromosome_cis_coverage(matrix, bin_chrom_ids, should_cancel)?;
    let mut vc = coverage_vector_weights(&cis_coverage, false);
    started(Normalization::VcSqrt);
    let mut vc_sqrt = coverage_vector_weights(&cis_coverage, true);
    if perf_enabled {
        eprintln!(
            "COOL2MCOOL_PERF event=normalization_vc_pair status=complete bins={} elapsed_ms={}",
            matrix.bin_count,
            phase_started.elapsed().as_millis(),
        );
    }

    let phase_started = std::time::Instant::now();
    rescale_stored_normalizations_in_one_scan(
        matrix,
        bin_chrom_ids,
        chromosome_count,
        &mut ice.weights,
        &mut kr.weights,
        &mut vc,
        &mut vc_sqrt,
        should_cancel,
    )?;
    if perf_enabled {
        eprintln!(
            "COOL2MCOOL_PERF event=normalization_rescale status=complete bins={} elapsed_ms={}",
            matrix.bin_count,
            phase_started.elapsed().as_millis(),
        );
    }

    Ok(StoredNormalizationResults {
        ice,
        kr,
        vc,
        vc_sqrt,
    })
}

pub(crate) fn compute_global_coverage_with_pool(
    matrix: &SparseContactMatrix,
    pool: &ThreadPool,
    should_cancel: &dyn Fn() -> bool,
) -> Result<Vec<f64>> {
    matrix.row_sums_with_pool(Some(pool), should_cancel)
}

pub(crate) fn compute_ice_from_shared_coverage(
    matrix: &SparseContactMatrix,
    coverage: &[f64],
    pool: &ThreadPool,
    should_cancel: &dyn Fn() -> bool,
) -> Result<IceNormalizationResult> {
    compute_ice_weights_from_coverage(matrix, coverage, Some(pool), true, should_cancel)
}

#[cfg(test)]
pub(crate) fn compute_kr_from_shared_coverage(
    matrix: &SparseContactMatrix,
    coverage: &[f64],
    pool: &ThreadPool,
    should_cancel: &dyn Fn() -> bool,
) -> Result<KrNormalizationResult> {
    compute_kr_weights_from_coverage(matrix, coverage, Some(pool), true, should_cancel)
}

/// Consume the shared CSR after ICE/VC have finished so the final long KR
/// retry can compact its active rows and columns in place without retaining a
/// second adjacency matrix.
pub(crate) fn compute_kr_from_shared_coverage_owned(
    matrix: SparseContactMatrix,
    coverage: &[f64],
    pool: &ThreadPool,
    should_cancel: &dyn Fn() -> bool,
) -> Result<KrNormalizationResult> {
    compute_kr_weights_from_coverage_owned(matrix, coverage, Some(pool), true, should_cancel)
}

pub(crate) fn compute_cis_coverage_pair_for_storage(
    matrix: &SparseContactMatrix,
    bin_chrom_ids: &[u32],
    chromosome_count: usize,
    should_cancel: &dyn Fn() -> bool,
) -> Result<(Vec<f64>, Vec<f64>)> {
    validate_bin_chromosomes(matrix, bin_chrom_ids, chromosome_count)?;
    let cis_coverage = chromosome_cis_coverage(matrix, bin_chrom_ids, should_cancel)?;
    let mut vc = coverage_vector_weights(&cis_coverage, false);
    let mut vc_sqrt = coverage_vector_weights(&cis_coverage, true);
    drop(cis_coverage);
    rescale_cis_pair_in_one_scan(
        matrix,
        bin_chrom_ids,
        chromosome_count,
        &mut vc,
        &mut vc_sqrt,
        should_cancel,
    )?;
    Ok((vc, vc_sqrt))
}

fn validate_bin_chromosomes(
    matrix: &SparseContactMatrix,
    bin_chrom_ids: &[u32],
    chromosome_count: usize,
) -> Result<()> {
    if bin_chrom_ids.len() != matrix.bin_count {
        return Err(normalization_error(format!(
            "bin chromosome index has {} entries for {} bins",
            bin_chrom_ids.len(),
            matrix.bin_count,
        )));
    }
    if bin_chrom_ids
        .iter()
        .any(|chromosome| *chromosome as usize >= chromosome_count)
    {
        return Err(normalization_error(
            "bin chromosome index exceeds the chromosome table",
        ));
    }
    Ok(())
}

fn chromosome_cis_coverage(
    matrix: &SparseContactMatrix,
    bin_chrom_ids: &[u32],
    should_cancel: &dyn Fn() -> bool,
) -> Result<Vec<f64>> {
    let mut coverage = vec![0.0; matrix.bin_count];
    matrix.for_each_positive_pixel(should_cancel, |first, second, count| {
        if bin_chrom_ids[first] != bin_chrom_ids[second] {
            return;
        }
        coverage[first] += count;
        if first != second {
            coverage[second] += count;
        }
    })?;
    Ok(coverage)
}

fn coverage_vector_weights(coverage: &[f64], square_root: bool) -> Vec<f64> {
    coverage
        .iter()
        .map(|value| {
            if !value.is_finite() || *value <= 0.0 {
                f64::NAN
            } else if square_root {
                1.0 / value.sqrt()
            } else {
                1.0 / value
            }
        })
        .collect()
}

#[allow(clippy::too_many_arguments)]
fn rescale_stored_normalizations_in_one_scan(
    matrix: &SparseContactMatrix,
    bin_chrom_ids: &[u32],
    chromosome_count: usize,
    ice: &mut [f64],
    kr: &mut [f64],
    vc: &mut [f64],
    vc_sqrt: &mut [f64],
    should_cancel: &dyn Fn() -> bool,
) -> Result<()> {
    for (label, weights) in [
        ("ICE", &*ice),
        ("KR", &*kr),
        ("VC", &*vc),
        ("VC_SQRT", &*vc_sqrt),
    ] {
        if weights.len() != matrix.bin_count {
            return Err(normalization_error(format!(
                "{label} has {} weights for {} matrix bins",
                weights.len(),
                matrix.bin_count,
            )));
        }
    }

    let mut global_raw = [0.0_f64; 2];
    let mut global_normalized = [0.0_f64; 2];
    let mut cis_raw = [vec![0.0; chromosome_count], vec![0.0; chromosome_count]];
    let mut cis_normalized = [vec![0.0; chromosome_count], vec![0.0; chromosome_count]];
    matrix.for_each_positive_pixel(should_cancel, |first, second, count| {
        let symmetry = if first == second { 1.0 } else { 2.0 };
        for (index, weights) in [&*ice, &*kr].into_iter().enumerate() {
            let first_weight = weights[first];
            let second_weight = weights[second];
            if valid_weight_pair(first_weight, second_weight) {
                global_raw[index] += symmetry * count;
                global_normalized[index] += symmetry * count * first_weight * second_weight;
            }
        }

        let chromosome = bin_chrom_ids[first] as usize;
        if chromosome != bin_chrom_ids[second] as usize {
            return;
        }
        for (index, weights) in [&*vc, &*vc_sqrt].into_iter().enumerate() {
            let first_weight = weights[first];
            let second_weight = weights[second];
            if valid_weight_pair(first_weight, second_weight) {
                cis_raw[index][chromosome] += symmetry * count;
                cis_normalized[index][chromosome] +=
                    symmetry * count * first_weight * second_weight;
            }
        }
    })?;

    apply_global_scale(ice, global_raw[0], global_normalized[0])?;
    apply_global_scale(kr, global_raw[1], global_normalized[1])?;
    apply_chromosome_scales(vc, bin_chrom_ids, &cis_raw[0], &cis_normalized[0]);
    apply_chromosome_scales(vc_sqrt, bin_chrom_ids, &cis_raw[1], &cis_normalized[1]);
    Ok(())
}

fn rescale_cis_pair_in_one_scan(
    matrix: &SparseContactMatrix,
    bin_chrom_ids: &[u32],
    chromosome_count: usize,
    vc: &mut [f64],
    vc_sqrt: &mut [f64],
    should_cancel: &dyn Fn() -> bool,
) -> Result<()> {
    if vc.len() != matrix.bin_count || vc_sqrt.len() != matrix.bin_count {
        return Err(normalization_error(
            "VC pair length does not match the matrix bin count",
        ));
    }
    let mut raw = [vec![0.0; chromosome_count], vec![0.0; chromosome_count]];
    let mut normalized = [vec![0.0; chromosome_count], vec![0.0; chromosome_count]];
    matrix.for_each_positive_pixel(should_cancel, |first, second, count| {
        let chromosome = bin_chrom_ids[first] as usize;
        if chromosome != bin_chrom_ids[second] as usize {
            return;
        }
        let symmetry = if first == second { 1.0 } else { 2.0 };
        for (index, weights) in [&*vc, &*vc_sqrt].into_iter().enumerate() {
            let first_weight = weights[first];
            let second_weight = weights[second];
            if valid_weight_pair(first_weight, second_weight) {
                raw[index][chromosome] += symmetry * count;
                normalized[index][chromosome] += symmetry * count * first_weight * second_weight;
            }
        }
    })?;
    apply_chromosome_scales(vc, bin_chrom_ids, &raw[0], &normalized[0]);
    apply_chromosome_scales(vc_sqrt, bin_chrom_ids, &raw[1], &normalized[1]);
    Ok(())
}

fn valid_weight_pair(first: f64, second: f64) -> bool {
    first.is_finite() && first > 0.0 && second.is_finite() && second > 0.0
}

fn apply_global_scale(weights: &mut [f64], raw_sum: f64, normalized_sum: f64) -> Result<()> {
    if raw_sum <= 0.0 || normalized_sum <= 0.0 {
        return Ok(());
    }
    let scale = (raw_sum / normalized_sum).sqrt();
    if !scale.is_finite() || scale <= 0.0 {
        return Err(normalization_error(
            "normalization total-preserving scale is non-finite",
        ));
    }
    for weight in weights {
        if weight.is_finite() && *weight > 0.0 {
            *weight *= scale;
        }
    }
    Ok(())
}

fn apply_chromosome_scales(
    weights: &mut [f64],
    bin_chrom_ids: &[u32],
    raw_sums: &[f64],
    normalized_sums: &[f64],
) {
    let scales = raw_sums
        .iter()
        .zip(normalized_sums)
        .map(|(raw_sum, normalized_sum)| {
            if *raw_sum > 0.0 && *normalized_sum > 0.0 {
                (raw_sum / normalized_sum).sqrt()
            } else {
                1.0
            }
        })
        .collect::<Vec<_>>();
    for (bin, weight) in weights.iter_mut().enumerate() {
        if weight.is_finite() && *weight > 0.0 {
            *weight *= scales[bin_chrom_ids[bin] as usize];
        }
    }
}

fn coverage_weights(
    matrix: &SparseContactMatrix,
    square_root: bool,
    should_cancel: &dyn Fn() -> bool,
) -> Result<Vec<f64>> {
    let coverage = matrix.row_sums(should_cancel)?;
    let mut weights = coverage
        .into_iter()
        .map(|value| {
            if !value.is_finite() || value <= 0.0 {
                f64::NAN
            } else if square_root {
                1.0 / value.sqrt()
            } else {
                1.0 / value
            }
        })
        .collect::<Vec<_>>();
    rescale_weights_to_preserve_total(matrix, &mut weights, should_cancel)?;
    Ok(weights)
}

fn ice_weights(matrix: &SparseContactMatrix, should_cancel: &dyn Fn() -> bool) -> Result<Vec<f64>> {
    let result = compute_ice_weights_for_storage(matrix, should_cancel)?;
    if !result.converged {
        return Err(normalization_error(format!(
            "ICE did not converge within {ICE_MAX_ITERATIONS} iterations (relative marginal variance {:.6e})",
            result.relative_variance,
        )));
    }
    Ok(result.weights)
}

pub fn compute_ice_weights_for_storage(
    matrix: &SparseContactMatrix,
    should_cancel: &dyn Fn() -> bool,
) -> Result<IceNormalizationResult> {
    let coverage = matrix.row_sums(should_cancel)?;
    compute_ice_weights_from_coverage(matrix, &coverage, None, true, should_cancel)
}

fn compute_ice_weights_from_coverage(
    matrix: &SparseContactMatrix,
    coverage: &[f64],
    pool: Option<&ThreadPool>,
    rescale: bool,
    should_cancel: &dyn Fn() -> bool,
) -> Result<IceNormalizationResult> {
    if !coverage
        .iter()
        .any(|value| value.is_finite() && *value > 0.0)
    {
        return Ok(IceNormalizationResult {
            weights: vec![f64::NAN; matrix.bin_count],
            converged: true,
            relative_variance: 0.0,
        });
    }
    let active = ice_active_bins(matrix, coverage, should_cancel)?;
    let mut weights = active
        .into_iter()
        .map(|is_active| if is_active { 1.0 } else { f64::NAN })
        .collect::<Vec<_>>();
    let mut converged = false;
    let mut last_variance = f64::INFINITY;
    let mut product = vec![0.0; matrix.bin_count];
    let mut marginals = vec![0.0; matrix.bin_count];

    for _ in 0..ICE_MAX_ITERATIONS {
        ensure_not_cancelled(should_cancel)?;
        matrix.multiply_into(&weights, &mut product, pool, should_cancel)?;
        for index in 0..marginals.len() {
            marginals[index] = weights[index] * product[index];
        }
        let Some(mean) = positive_mean(&marginals) else {
            return Err(normalization_error(
                "ICE has no positive marginal after filtering",
            ));
        };
        let (squared_error, valid_count) = marginals
            .iter()
            .filter(|value| value.is_finite() && **value > 0.0)
            .fold((0.0, 0_usize), |(sum, count), value| {
                (sum + (value / mean - 1.0).powi(2), count + 1)
            });
        let variance = squared_error / valid_count.max(1) as f64;
        last_variance = variance;
        if variance <= ICE_TOLERANCE {
            converged = true;
            break;
        }

        for (weight, marginal) in weights.iter_mut().zip(marginals.iter().copied()) {
            if !weight.is_finite() || !marginal.is_finite() || marginal <= 0.0 {
                *weight = f64::NAN;
                continue;
            }
            // Simultaneous symmetric row/column correction needs the square root
            // of the marginal ratio; the undamped update oscillates on diagonals.
            *weight /= (marginal / mean).sqrt();
        }
        normalize_finite_weight_scale(&mut weights);
    }

    if !converged {
        matrix.multiply_into(&weights, &mut product, pool, should_cancel)?;
        for index in 0..marginals.len() {
            marginals[index] = weights[index] * product[index];
        }
        if let Some(mean) = positive_mean(&marginals) {
            let (squared_error, valid_count) = marginals
                .iter()
                .filter(|value| value.is_finite() && **value > 0.0)
                .fold((0.0, 0_usize), |(sum, count), value| {
                    (sum + (value / mean - 1.0).powi(2), count + 1)
                });
            last_variance = squared_error / valid_count.max(1) as f64;
            converged = last_variance <= ICE_TOLERANCE;
        }
    }
    if rescale {
        rescale_weights_to_preserve_total(matrix, &mut weights, should_cancel)?;
    }
    Ok(IceNormalizationResult {
        weights,
        converged,
        relative_variance: last_variance,
    })
}

pub fn compute_kr_weights_for_storage(
    matrix: &SparseContactMatrix,
    should_cancel: &dyn Fn() -> bool,
) -> Result<KrNormalizationResult> {
    let coverage = matrix.row_sums(should_cancel)?;
    compute_kr_weights_from_coverage(matrix, &coverage, None, true, should_cancel)
}

fn compute_kr_weights_from_coverage(
    matrix: &SparseContactMatrix,
    coverage: &[f64],
    pool: Option<&ThreadPool>,
    rescale: bool,
    should_cancel: &dyn Fn() -> bool,
) -> Result<KrNormalizationResult> {
    if !coverage
        .iter()
        .any(|value| value.is_finite() && *value > 0.0)
    {
        return Ok(KrNormalizationResult {
            weights: vec![f64::NAN; matrix.bin_count],
            coverage_percentile: 0.0,
        });
    }
    let global_matrix = GlobalKrMatrix::from_sparse(matrix, should_cancel)?;

    let mut last_error = None;
    let mut previous_active_count = None;
    let mut warm_start: Option<KrWarmStart> = None;
    for (retry_index, percentile) in KR_RETRY_PERCENTILES.into_iter().enumerate() {
        ensure_not_cancelled(should_cancel)?;
        let attempt_started = std::time::Instant::now();
        let coverage_threshold = positive_coverage_percentile(coverage, percentile);
        let support_started = std::time::Instant::now();
        let support =
            global_matrix.active_support(coverage, coverage_threshold, pool, should_cancel)?;
        let support_ms = support_started.elapsed().as_millis();
        let active_count = support.active_bins.len();
        if previous_active_count == Some(active_count) {
            continue;
        }
        previous_active_count = Some(active_count);
        let final_long_retry = retry_index + 1 == KR_RETRY_PERCENTILES.len();
        let matrix_vector_product_limit = if final_long_retry {
            KR_MAX_MATRIX_VECTOR_PRODUCTS
        } else {
            // Failed low-percentile attempts are deliberately bounded so a
            // sparse map cannot spend the full KR budget at every threshold
            // before reaching the final extended support retry.
            KR_MAX_RETRY_MATRIX_VECTOR_PRODUCTS
        };
        let normalize_initial_scale = final_long_retry && warm_start.is_some();
        let initial = if final_long_retry && warm_start.is_some() {
            warm_start
                .as_ref()
                .expect("the final KR retry has an internal warm start")
                .stabilized_for_support(&support)
        } else {
            vec![1.0; support.active_bins.len()]
        };
        let mut stats = KrIterationStats::default();
        let result = knight_ruiz_attempt_with_active_bins(
            matrix,
            &global_matrix,
            support,
            initial,
            normalize_initial_scale,
            matrix_vector_product_limit,
            pool,
            rescale,
            should_cancel,
            &mut stats,
        );
        match result {
            Ok(KrAttemptOutcome::Converged(weights)) => {
                log_kr_attempt(
                    "ok",
                    percentile,
                    active_count,
                    matrix_vector_product_limit,
                    support_ms,
                    attempt_started.elapsed(),
                    "global",
                    matrix.counts.len(),
                    &stats,
                    None,
                );
                return Ok(KrNormalizationResult {
                    weights,
                    coverage_percentile: percentile,
                });
            }
            Ok(KrAttemptOutcome::BudgetExhausted(seed)) => {
                let error = normalization_error(
                    "KR did not converge within the matrix-vector product limit",
                );
                log_kr_attempt(
                    "retry",
                    percentile,
                    active_count,
                    matrix_vector_product_limit,
                    support_ms,
                    attempt_started.elapsed(),
                    "global",
                    matrix.counts.len(),
                    &stats,
                    Some(&error),
                );
                warm_start = Some(seed);
                last_error = Some(error);
            }
            Err(Error::Cancelled) => return Err(Error::Cancelled),
            Err(error) => {
                log_kr_attempt(
                    "failed",
                    percentile,
                    active_count,
                    matrix_vector_product_limit,
                    support_ms,
                    attempt_started.elapsed(),
                    "global",
                    matrix.counts.len(),
                    &stats,
                    Some(&error),
                );
                last_error = Some(error);
            }
        }
    }

    Err(last_error.unwrap_or_else(|| normalization_error("KR could not select any active bins")))
}

fn compute_kr_weights_from_coverage_owned(
    matrix: SparseContactMatrix,
    coverage: &[f64],
    pool: Option<&ThreadPool>,
    rescale: bool,
    should_cancel: &dyn Fn() -> bool,
) -> Result<KrNormalizationResult> {
    if !coverage
        .iter()
        .any(|value| value.is_finite() && *value > 0.0)
    {
        return Ok(KrNormalizationResult {
            weights: vec![f64::NAN; matrix.bin_count],
            coverage_percentile: 0.0,
        });
    }
    GlobalKrMatrix::from_sparse(&matrix, should_cancel)?;
    let mut matrix = Some(matrix);
    let mut last_error = None;
    let mut previous_active_count = None;
    let mut warm_start: Option<KrWarmStart> = None;

    for (retry_index, percentile) in KR_RETRY_PERCENTILES.into_iter().enumerate() {
        ensure_not_cancelled(should_cancel)?;
        let attempt_started = std::time::Instant::now();
        let coverage_threshold = positive_coverage_percentile(coverage, percentile);
        let support_started = std::time::Instant::now();
        let support = {
            let global_matrix = GlobalKrMatrix {
                matrix: matrix
                    .as_ref()
                    .expect("owned KR matrix is retained until the final retry"),
            };
            global_matrix.active_support(coverage, coverage_threshold, pool, should_cancel)?
        };
        let support_ms = support_started.elapsed().as_millis();
        let active_count = support.active_bins.len();
        if previous_active_count == Some(active_count) {
            continue;
        }
        previous_active_count = Some(active_count);
        let final_long_retry = retry_index + 1 == KR_RETRY_PERCENTILES.len();
        let matrix_vector_product_limit = if final_long_retry {
            KR_MAX_MATRIX_VECTOR_PRODUCTS
        } else {
            KR_MAX_RETRY_MATRIX_VECTOR_PRODUCTS
        };
        let normalize_initial_scale = final_long_retry && warm_start.is_some();
        let initial = if final_long_retry && warm_start.is_some() {
            warm_start
                .as_ref()
                .expect("the final KR retry has an internal warm start")
                .stabilized_for_support(&support)
        } else {
            vec![1.0; support.active_bins.len()]
        };
        let mut stats = KrIterationStats::default();

        if final_long_retry {
            let compact_matrix = matrix
                .take()
                .expect("owned KR matrix is available for compaction")
                .into_compact_kr(support, should_cancel)?;
            let matrix_entries = compact_matrix.counts.len();
            let mut initial = initial;
            let boundary_leaf_count =
                apply_compact_kr_boundary_warm_start(&compact_matrix, &mut initial);
            let prebalance_started = std::time::Instant::now();
            let prebalance_mvp = if normalize_initial_scale {
                prebalance_compact_kr_warm_start(
                    &compact_matrix,
                    &mut initial,
                    KR_WARM_START_PREBALANCE_ITERATIONS,
                    pool,
                    should_cancel,
                )?
            } else {
                0
            };
            if std::env::var("COOL2MCOOL_PERF_LOG").as_deref() == Ok("1") {
                eprintln!(
                    "COOL2MCOOL_PERF event=kr_warm_start_prepare status=complete boundary_leaves={} prebalance_mvp={} elapsed_ms={}",
                    boundary_leaf_count,
                    prebalance_mvp,
                    prebalance_started.elapsed().as_millis(),
                );
            }
            let result = knight_ruiz_attempt_with_compact_matrix(
                &compact_matrix,
                initial,
                normalize_initial_scale,
                matrix_vector_product_limit,
                pool,
                rescale,
                should_cancel,
                &mut stats,
            );
            match result {
                Ok(KrAttemptOutcome::Converged(weights)) => {
                    log_kr_attempt(
                        "ok",
                        percentile,
                        active_count,
                        matrix_vector_product_limit,
                        support_ms,
                        attempt_started.elapsed(),
                        compact_matrix.kind(),
                        matrix_entries,
                        &stats,
                        None,
                    );
                    return Ok(KrNormalizationResult {
                        weights,
                        coverage_percentile: percentile,
                    });
                }
                Ok(KrAttemptOutcome::BudgetExhausted(_)) => {
                    let error = normalization_error(
                        "KR did not converge within the matrix-vector product limit",
                    );
                    log_kr_attempt(
                        "failed",
                        percentile,
                        active_count,
                        matrix_vector_product_limit,
                        support_ms,
                        attempt_started.elapsed(),
                        compact_matrix.kind(),
                        matrix_entries,
                        &stats,
                        Some(&error),
                    );
                    return Err(error);
                }
                Err(Error::Cancelled) => return Err(Error::Cancelled),
                Err(error) => {
                    log_kr_attempt(
                        "failed",
                        percentile,
                        active_count,
                        matrix_vector_product_limit,
                        support_ms,
                        attempt_started.elapsed(),
                        compact_matrix.kind(),
                        matrix_entries,
                        &stats,
                        Some(&error),
                    );
                    return Err(error);
                }
            }
        }

        let result = {
            let borrowed_matrix = matrix
                .as_ref()
                .expect("owned KR matrix is retained during bounded retries");
            let global_matrix = GlobalKrMatrix {
                matrix: borrowed_matrix,
            };
            knight_ruiz_attempt_with_active_bins(
                borrowed_matrix,
                &global_matrix,
                support,
                initial,
                normalize_initial_scale,
                matrix_vector_product_limit,
                pool,
                rescale,
                should_cancel,
                &mut stats,
            )
        };
        match result {
            Ok(KrAttemptOutcome::Converged(weights)) => {
                let matrix_entries = matrix
                    .as_ref()
                    .expect("owned KR matrix remains after a bounded retry")
                    .counts
                    .len();
                log_kr_attempt(
                    "ok",
                    percentile,
                    active_count,
                    matrix_vector_product_limit,
                    support_ms,
                    attempt_started.elapsed(),
                    "global",
                    matrix_entries,
                    &stats,
                    None,
                );
                return Ok(KrNormalizationResult {
                    weights,
                    coverage_percentile: percentile,
                });
            }
            Ok(KrAttemptOutcome::BudgetExhausted(seed)) => {
                let matrix_entries = matrix
                    .as_ref()
                    .expect("owned KR matrix remains after a bounded retry")
                    .counts
                    .len();
                let error = normalization_error(
                    "KR did not converge within the matrix-vector product limit",
                );
                log_kr_attempt(
                    "retry",
                    percentile,
                    active_count,
                    matrix_vector_product_limit,
                    support_ms,
                    attempt_started.elapsed(),
                    "global",
                    matrix_entries,
                    &stats,
                    Some(&error),
                );
                warm_start = Some(seed);
                last_error = Some(error);
            }
            Err(Error::Cancelled) => return Err(Error::Cancelled),
            Err(error) => {
                let matrix_entries = matrix
                    .as_ref()
                    .expect("owned KR matrix remains after a bounded retry")
                    .counts
                    .len();
                log_kr_attempt(
                    "failed",
                    percentile,
                    active_count,
                    matrix_vector_product_limit,
                    support_ms,
                    attempt_started.elapsed(),
                    "global",
                    matrix_entries,
                    &stats,
                    Some(&error),
                );
                last_error = Some(error);
            }
        }
    }

    Err(last_error.unwrap_or_else(|| normalization_error("KR could not select any active bins")))
}

#[allow(clippy::too_many_arguments)]
fn log_kr_attempt(
    status: &str,
    percentile: f64,
    active_bins: usize,
    matrix_vector_product_limit: usize,
    support_ms: u128,
    elapsed: std::time::Duration,
    matrix_kind: &str,
    matrix_entries: usize,
    stats: &KrIterationStats,
    error: Option<&Error>,
) {
    if std::env::var("COOL2MCOOL_PERF_LOG").as_deref() != Ok("1") {
        return;
    }
    let mvp_seconds = stats.matrix_vector_product_nanos as f64 / 1_000_000_000.0;
    let effective_csr_gbps = if mvp_seconds > 0.0 {
        matrix_entries as f64
            * (std::mem::size_of::<u32>() + std::mem::size_of::<f64>()) as f64
            * stats.matrix_vector_products as f64
            / mvp_seconds
            / 1_000_000_000.0
    } else {
        0.0
    };
    let error = error
        .map(|error| format!(" error={error}"))
        .unwrap_or_default();
    eprintln!(
        "COOL2MCOOL_PERF event=kr_attempt status={} percentile={} active_bins={} mvp_limit={} support_ms={} elapsed_ms={} matrix_kind={} matrix_entries={} outer={} inner={} mvp={} mvp_ms={:.3} effective_csr_gbps={:.3}{}",
        status,
        percentile,
        active_bins,
        matrix_vector_product_limit,
        support_ms,
        elapsed.as_millis(),
        matrix_kind,
        matrix_entries,
        stats.outer_iterations,
        stats.inner_iterations,
        stats.matrix_vector_products,
        stats.matrix_vector_product_nanos as f64 / 1_000_000.0,
        effective_csr_gbps,
        error,
    );
}

#[cfg(test)]
#[allow(clippy::too_many_arguments)]
fn knight_ruiz_weights_with_active_bins(
    matrix: &SparseContactMatrix,
    global_matrix: &GlobalKrMatrix,
    support: ActiveKrSupport,
    matrix_vector_product_limit: usize,
    pool: Option<&ThreadPool>,
    rescale: bool,
    should_cancel: &dyn Fn() -> bool,
    stats: &mut KrIterationStats,
) -> Result<Vec<f64>> {
    let initial = vec![1.0; support.active_bins.len()];
    match knight_ruiz_attempt_with_active_bins(
        matrix,
        global_matrix,
        support,
        initial,
        false,
        matrix_vector_product_limit,
        pool,
        rescale,
        should_cancel,
        stats,
    )? {
        KrAttemptOutcome::Converged(weights) => Ok(weights),
        KrAttemptOutcome::BudgetExhausted(_) => Err(normalization_error(
            "KR did not converge within the matrix-vector product limit",
        )),
    }
}

#[allow(clippy::too_many_arguments)]
fn knight_ruiz_attempt_with_active_bins(
    matrix: &SparseContactMatrix,
    global_matrix: &GlobalKrMatrix,
    support: ActiveKrSupport,
    initial: Vec<f64>,
    normalize_initial_scale: bool,
    matrix_vector_product_limit: usize,
    pool: Option<&ThreadPool>,
    rescale: bool,
    should_cancel: &dyn Fn() -> bool,
    stats: &mut KrIterationStats,
) -> Result<KrAttemptOutcome> {
    if support.active_bins.is_empty() {
        return Err(normalization_error("KR could not select any active bins"));
    }
    if initial.len() != support.active_bins.len() {
        return Err(normalization_error(
            "KR warm start and active support have different sizes",
        ));
    }

    let active_matrix = ActiveGlobalKrMatrix {
        matrix: global_matrix,
        support: &support,
    };
    let outcome = knight_ruiz_bnewt(
        &active_matrix,
        initial,
        normalize_initial_scale,
        matrix_vector_product_limit,
        pool,
        should_cancel,
        stats,
    )?;
    match outcome {
        KrBnewtOutcome::Converged(compact) => {
            let mut weights = vec![f64::NAN; matrix.bin_count];
            for (compact_index, bin) in support.active_bins.into_iter().enumerate() {
                let value = compact[compact_index];
                if value.is_finite() && value > 0.0 {
                    weights[bin as usize] = value;
                }
            }
            if rescale {
                rescale_weights_to_preserve_total(matrix, &mut weights, should_cancel)?;
            }
            Ok(KrAttemptOutcome::Converged(weights))
        }
        KrBnewtOutcome::BudgetExhausted(compact) => {
            Ok(KrAttemptOutcome::BudgetExhausted(KrWarmStart {
                active_bins: support.active_bins,
                weights: compact,
            }))
        }
    }
}

#[cfg(test)]
fn knight_ruiz_weights_with_compact_matrix(
    matrix: &CompactKrMatrix,
    matrix_vector_product_limit: usize,
    pool: Option<&ThreadPool>,
    rescale: bool,
    should_cancel: &dyn Fn() -> bool,
    stats: &mut KrIterationStats,
) -> Result<Vec<f64>> {
    let initial = vec![1.0; matrix.active_bins.len()];
    match knight_ruiz_attempt_with_compact_matrix(
        matrix,
        initial,
        false,
        matrix_vector_product_limit,
        pool,
        rescale,
        should_cancel,
        stats,
    )? {
        KrAttemptOutcome::Converged(weights) => Ok(weights),
        KrAttemptOutcome::BudgetExhausted(_) => Err(normalization_error(
            "KR did not converge within the matrix-vector product limit",
        )),
    }
}

#[allow(clippy::too_many_arguments)]
fn knight_ruiz_attempt_with_compact_matrix(
    matrix: &CompactKrMatrix,
    initial: Vec<f64>,
    normalize_initial_scale: bool,
    matrix_vector_product_limit: usize,
    pool: Option<&ThreadPool>,
    rescale: bool,
    should_cancel: &dyn Fn() -> bool,
    stats: &mut KrIterationStats,
) -> Result<KrAttemptOutcome> {
    if matrix.active_bins.is_empty() {
        return Err(normalization_error("KR could not select any active bins"));
    }
    if initial.len() != matrix.active_bins.len() {
        return Err(normalization_error(
            "KR warm start and compact matrix have different sizes",
        ));
    }
    match knight_ruiz_bnewt(
        matrix,
        initial,
        normalize_initial_scale,
        matrix_vector_product_limit,
        pool,
        should_cancel,
        stats,
    )? {
        KrBnewtOutcome::Converged(mut compact) => {
            if rescale {
                matrix.rescale_weights_to_preserve_total(&mut compact, should_cancel)?;
            }
            Ok(KrAttemptOutcome::Converged(matrix.expand_weights(compact)))
        }
        KrBnewtOutcome::BudgetExhausted(compact) => {
            Ok(KrAttemptOutcome::BudgetExhausted(KrWarmStart {
                active_bins: matrix.active_bins.clone(),
                weights: compact,
            }))
        }
    }
}

fn apply_compact_kr_boundary_warm_start(matrix: &CompactKrMatrix, initial: &mut [f64]) -> usize {
    debug_assert_eq!(matrix.size(), initial.len());
    let leaves = (0..matrix.size())
        .filter_map(|row| {
            let start = matrix.row_offsets[row];
            let end = matrix.row_offsets[row + 1];
            if end - start != 1 {
                return None;
            }
            let hub = matrix.columns[start] as usize;
            if hub == row || matrix.row_offsets[hub + 1] - matrix.row_offsets[hub] <= 1 {
                return None;
            }
            Some((row, hub, matrix.counts[start]))
        })
        .collect::<Vec<_>>();

    for &(_, hub, _) in &leaves {
        initial[hub] = initial[hub].min(KR_BOUNDARY_WARM_START_HUB_WEIGHT);
    }
    for &(leaf, hub, count) in &leaves {
        initial[leaf] = 1.0 / (count * initial[hub]);
    }
    leaves.len()
}

fn prebalance_compact_kr_warm_start(
    matrix: &CompactKrMatrix,
    initial: &mut [f64],
    iterations: usize,
    pool: Option<&ThreadPool>,
    should_cancel: &dyn Fn() -> bool,
) -> Result<usize> {
    debug_assert_eq!(matrix.size(), initial.len());
    let parallel_vectors = pool.is_some() && initial.len() >= PARALLEL_VECTOR_LENGTH_THRESHOLD;
    let mut product = vec![0.0; initial.len()];
    for _ in 0..iterations {
        matrix.multiply_rows(initial, &mut product, pool, should_cancel)?;
        if parallel_vectors {
            run_in_pool(pool, || {
                initial
                    .par_iter_mut()
                    .zip(product.par_iter())
                    .for_each(|(weight, product)| {
                        let marginal = *weight * *product;
                        if marginal.is_finite() && marginal > NUMERIC_EPSILON {
                            *weight /= marginal.sqrt();
                        }
                    });
            });
        } else {
            for (weight, product) in initial.iter_mut().zip(product.iter()) {
                let marginal = *weight * *product;
                if marginal.is_finite() && marginal > NUMERIC_EPSILON {
                    *weight /= marginal.sqrt();
                }
            }
        }
        if initial
            .iter()
            .any(|weight| !weight.is_finite() || *weight <= 0.0)
        {
            return Err(normalization_error(
                "KR warm-start prebalance produced a non-positive weight",
            ));
        }
    }
    Ok(iterations)
}

#[allow(clippy::too_many_arguments)]
fn knight_ruiz_bnewt<M: KrMatrixOperator>(
    matrix: &M,
    mut x: Vec<f64>,
    normalize_initial_scale: bool,
    matrix_vector_product_limit: usize,
    pool: Option<&ThreadPool>,
    should_cancel: &dyn Fn() -> bool,
    stats: &mut KrIterationStats,
) -> Result<KrBnewtOutcome> {
    let size = matrix.size();
    if x.len() != size {
        return Err(normalization_error(
            "KR initial vector and matrix have different sizes",
        ));
    }
    let parallel_vectors = pool.is_some() && size >= PARALLEL_VECTOR_LENGTH_THRESHOLD;
    // Juicebox's BNEWT stopping condition is a global L2 residual, not an RMS
    // residual that becomes progressively looser as the matrix grows.
    let residual_target = KR_TOLERANCE * KR_TOLERANCE;
    let delta = 0.1;
    let gamma_coefficient = 0.9;
    let eta_max = 0.1;
    let mut eta = eta_max;
    // Global retries use a global-bin expansion scratch. The final compact
    // retry needs only one active-vector scratch for in-place products.
    let mut matrix_scratch = vec![0.0; matrix.scratch_len()];
    let mut v = vec![0.0; size];
    let mvp_started = std::time::Instant::now();
    matrix.multiply_into(&x, &mut matrix_scratch, &mut v, pool, should_cancel)?;
    stats.matrix_vector_product_nanos += mvp_started.elapsed().as_nanos();
    stats.matrix_vector_products += 1;
    if normalize_initial_scale {
        let normalized_marginal_sum = x
            .iter()
            .zip(v.iter())
            .map(|(weight, product)| weight * product)
            .sum::<f64>();
        let scale = (size as f64 / normalized_marginal_sum).sqrt();
        if !scale.is_finite() || scale <= 0.0 {
            return Err(normalization_error(
                "KR warm start has a non-finite global scale",
            ));
        }
        if parallel_vectors {
            run_in_pool(pool, || {
                x.par_iter_mut()
                    .zip(v.par_iter_mut())
                    .for_each(|(weight, product)| {
                        *weight *= scale;
                        *product *= scale;
                    });
            });
        } else {
            for index in 0..size {
                x[index] *= scale;
                v[index] *= scale;
            }
        }
    }
    if parallel_vectors {
        run_in_pool(pool, || {
            v.par_iter_mut()
                .zip(x.par_iter())
                .for_each(|(value, weight)| *value *= *weight);
        });
    } else {
        for index in 0..size {
            v[index] *= x[index];
        }
    }
    if v.iter()
        .any(|value| !value.is_finite() || *value <= NUMERIC_EPSILON)
    {
        return Err(normalization_error(
            "KR encountered a zero or non-finite active marginal",
        ));
    }
    let mut residual = if parallel_vectors {
        run_in_pool(pool, || {
            v.par_iter().map(|value| 1.0 - value).collect::<Vec<_>>()
        })
    } else {
        v.iter().map(|value| 1.0 - value).collect::<Vec<_>>()
    };
    let mut rho = squared_norm(&residual);
    if normalize_initial_scale && std::env::var("COOL2MCOOL_PERF_LOG").as_deref() == Ok("1") {
        eprintln!(
            "COOL2MCOOL_PERF event=kr_warm_start status=initialized squared_residual={rho:.6e}"
        );
    }
    let mut outer_residual = rho;
    let mut old_outer_residual = outer_residual;
    let mut stagnant_iterations = 0_usize;
    let mut y = vec![1.0; size];
    let mut direction = vec![0.0; size];
    let mut scaled_direction = vec![0.0; size];

    // Juicebox does not cap the number of outer Newton iterations. It keeps
    // iterating until the global L2 residual converges or 100 iterations have
    // made less than 1e-6 absolute progress. The matrix-vector-product budget
    // below remains our defensive bound for malformed inputs.
    loop {
        if outer_residual <= residual_target {
            return Ok(KrBnewtOutcome::Converged(x));
        }
        if stagnant_iterations >= KR_MAX_STAGNANT_ITERATIONS {
            return Err(normalization_error(format!(
                "KR stopped improving before convergence (outer_iterations={}, matrix_vector_products={}, squared_residual={outer_residual:.6e})",
                stats.outer_iterations,
                stats.matrix_vector_products,
            )));
        }
        ensure_not_cancelled(should_cancel)?;
        stats.outer_iterations += 1;

        y.fill(1.0);
        direction.fill(0.0);
        let mut previous_rho = rho;
        let inner_tolerance = (eta * eta * outer_residual).max(residual_target);

        for inner_iteration in 0..KR_MAX_INNER_ITERATIONS {
            if rho <= inner_tolerance {
                break;
            }
            stats.inner_iterations += 1;
            if inner_iteration == 0 {
                rho = 0.0;
                for index in 0..size {
                    direction[index] = residual[index] / v[index];
                    rho += residual[index] * direction[index];
                }
            } else {
                if !previous_rho.is_finite() || previous_rho <= NUMERIC_EPSILON {
                    return Err(normalization_error(
                        "KR conjugate-gradient residual vanished",
                    ));
                }
                let beta = rho / previous_rho;
                if parallel_vectors {
                    run_in_pool(pool, || {
                        direction
                            .par_iter_mut()
                            .enumerate()
                            .for_each(|(index, direction)| {
                                *direction = residual[index] / v[index] + beta * *direction;
                            });
                    });
                } else {
                    for index in 0..size {
                        direction[index] = residual[index] / v[index] + beta * direction[index];
                    }
                }
            }

            if parallel_vectors {
                run_in_pool(pool, || {
                    scaled_direction
                        .par_iter_mut()
                        .zip(x.par_iter().zip(direction.par_iter()))
                        .for_each(|(scaled, (weight, direction))| {
                            *scaled = *weight * *direction;
                        });
                });
            } else {
                for index in 0..size {
                    scaled_direction[index] = x[index] * direction[index];
                }
            }
            let mvp_started = std::time::Instant::now();
            matrix.multiply_in_place(
                &mut scaled_direction,
                &mut matrix_scratch,
                pool,
                should_cancel,
            )?;
            stats.matrix_vector_product_nanos += mvp_started.elapsed().as_nanos();
            stats.matrix_vector_products += 1;
            if stats.matrix_vector_products > matrix_vector_product_limit {
                return Ok(KrBnewtOutcome::BudgetExhausted(x));
            }

            let mut denominator = 0.0;
            for index in 0..size {
                let hessian = x[index] * scaled_direction[index] + v[index] * direction[index];
                denominator += direction[index] * hessian;
            }
            // Juicebox permits a negative Newton denominator and therefore a
            // negative step. The subsequent positive-cone boundary check is
            // what constrains the iterate; rejecting the sign here can abort
            // a valid large sparse assembly matrix late in convergence.
            if !denominator.is_finite() || denominator.abs() <= NUMERIC_EPSILON {
                return Err(normalization_error(format!(
                    "KR encountered a zero or non-finite Newton denominator (outer_iterations={}, matrix_vector_products={}, squared_residual={outer_residual:.6e}, preconditioned_residual={rho:.6e}, denominator={denominator:.6e})",
                    stats.outer_iterations,
                    stats.matrix_vector_products,
                )));
            }
            let alpha = rho / denominator;
            if !alpha.is_finite() || alpha.abs() <= NUMERIC_EPSILON {
                return Err(normalization_error("KR produced an invalid Newton step"));
            }

            let mut minimum_y = f64::INFINITY;
            for index in 0..size {
                minimum_y = minimum_y.min(y[index] + alpha * direction[index]);
            }
            if minimum_y <= delta {
                let mut boundary_step = f64::INFINITY;
                for index in 0..size {
                    let step = alpha * direction[index];
                    if step < 0.0 {
                        boundary_step = boundary_step.min((delta - y[index]) / step);
                    }
                }
                if !boundary_step.is_finite() || boundary_step <= 0.0 {
                    return Err(normalization_error(
                        "KR could not remain in the positive cone",
                    ));
                }
                let step_scale = boundary_step * alpha;
                if parallel_vectors {
                    run_in_pool(pool, || {
                        y.par_iter_mut()
                            .zip(direction.par_iter())
                            .for_each(|(y, direction)| *y += step_scale * *direction);
                    });
                } else {
                    for index in 0..size {
                        y[index] += step_scale * direction[index];
                    }
                }
                break;
            }

            if parallel_vectors {
                run_in_pool(pool, || {
                    y.par_iter_mut()
                        .zip(direction.par_iter())
                        .for_each(|(y, direction)| *y += alpha * *direction);
                });
            } else {
                for index in 0..size {
                    y[index] += alpha * direction[index];
                }
            }
            previous_rho = rho;
            if parallel_vectors {
                run_in_pool(pool, || {
                    residual
                        .par_iter_mut()
                        .enumerate()
                        .for_each(|(index, residual)| {
                            let hessian =
                                x[index] * scaled_direction[index] + v[index] * direction[index];
                            *residual -= alpha * hessian;
                        });
                });
            } else {
                for index in 0..size {
                    let hessian = x[index] * scaled_direction[index] + v[index] * direction[index];
                    residual[index] -= alpha * hessian;
                }
            }
            rho = 0.0;
            for index in 0..size {
                rho += residual[index] * (residual[index] / v[index]);
            }
            if !rho.is_finite() || rho < 0.0 {
                return Err(normalization_error("KR residual became non-finite"));
            }
        }

        if parallel_vectors {
            run_in_pool(pool, || {
                x.par_iter_mut()
                    .zip(y.par_iter())
                    .for_each(|(weight, correction)| *weight *= *correction);
            });
        } else {
            for index in 0..size {
                x[index] *= y[index];
            }
        }
        if x.iter().any(|value| !value.is_finite() || *value <= 0.0) {
            return Err(normalization_error("KR produced a non-positive weight"));
        }
        let mvp_started = std::time::Instant::now();
        matrix.multiply_into(&x, &mut matrix_scratch, &mut v, pool, should_cancel)?;
        stats.matrix_vector_product_nanos += mvp_started.elapsed().as_nanos();
        stats.matrix_vector_products += 1;
        if stats.matrix_vector_products > matrix_vector_product_limit {
            return Ok(KrBnewtOutcome::BudgetExhausted(x));
        }
        if parallel_vectors {
            run_in_pool(pool, || {
                v.par_iter_mut()
                    .zip(residual.par_iter_mut())
                    .zip(x.par_iter())
                    .for_each(|((value, residual), weight)| {
                        *value *= *weight;
                        *residual = 1.0 - *value;
                    });
            });
        } else {
            for index in 0..size {
                v[index] *= x[index];
                residual[index] = 1.0 - v[index];
            }
        }
        if v.iter()
            .any(|value| !value.is_finite() || *value <= NUMERIC_EPSILON)
        {
            return Err(normalization_error("KR produced an invalid marginal"));
        }
        rho = squared_norm(&residual);
        if !rho.is_finite() {
            return Err(normalization_error("KR residual became non-finite"));
        }
        if (rho - outer_residual).abs() < KR_STAGNANT_RESIDUAL_DELTA || rho.is_infinite() {
            stagnant_iterations += 1;
        }

        outer_residual = rho;
        let ratio = if old_outer_residual > NUMERIC_EPSILON {
            outer_residual / old_outer_residual
        } else {
            0.0
        };
        old_outer_residual = outer_residual;
        let residual_norm = outer_residual.sqrt();
        let previous_eta = eta;
        eta = gamma_coefficient * ratio;
        if gamma_coefficient * previous_eta * previous_eta > 0.1 {
            eta = eta.max(gamma_coefficient * previous_eta * previous_eta);
        }
        if residual_norm > NUMERIC_EPSILON {
            eta = eta.max(0.5 * KR_TOLERANCE / residual_norm);
        }
        eta = eta.min(eta_max);
    }
}

fn rescale_weights_to_preserve_total(
    matrix: &SparseContactMatrix,
    weights: &mut [f64],
    should_cancel: &dyn Fn() -> bool,
) -> Result<()> {
    let mut raw_sum = 0.0;
    let mut normalized_sum = 0.0;
    matrix.for_each_positive_pixel(should_cancel, |first, second, count| {
        let first_weight = weights[first];
        let second_weight = weights[second];
        if !first_weight.is_finite()
            || first_weight <= 0.0
            || !second_weight.is_finite()
            || second_weight <= 0.0
        {
            return;
        }
        let symmetry = if first == second { 1.0 } else { 2.0 };
        raw_sum += symmetry * count;
        normalized_sum += symmetry * count * first_weight * second_weight;
    })?;
    if raw_sum <= 0.0 || normalized_sum <= 0.0 {
        return Ok(());
    }
    let scale = (raw_sum / normalized_sum).sqrt();
    if !scale.is_finite() || scale <= 0.0 {
        return Err(normalization_error(
            "normalization total-preserving scale is non-finite",
        ));
    }
    for weight in weights {
        if weight.is_finite() && *weight > 0.0 {
            *weight *= scale;
        }
    }
    Ok(())
}

fn normalize_finite_weight_scale(weights: &mut [f64]) {
    let mut log_sum = 0.0;
    let mut count = 0_usize;
    for weight in weights.iter() {
        if weight.is_finite() && *weight > 0.0 {
            log_sum += weight.ln();
            count += 1;
        }
    }
    if count == 0 {
        return;
    }
    let scale = (-log_sum / count as f64).exp();
    if !scale.is_finite() || scale <= 0.0 {
        return;
    }
    for weight in weights {
        if weight.is_finite() && *weight > 0.0 {
            *weight *= scale;
        }
    }
}

fn ice_active_bins(
    matrix: &SparseContactMatrix,
    coverage: &[f64],
    should_cancel: &dyn Fn() -> bool,
) -> Result<Vec<bool>> {
    let positive_count = coverage
        .iter()
        .filter(|value| value.is_finite() && **value > 0.0)
        .count();
    if positive_count < 1_000 {
        return Ok(coverage
            .iter()
            .map(|value| value.is_finite() && *value > 0.0)
            .collect());
    }

    // Mirror Cooler's explicit ICE preprocessing defaults for large maps:
    // remove bins with fewer than 10 nonzero contacts and extreme low-count
    // outliers below five median absolute deviations in log coverage.
    let nonzero_counts = matrix.row_nonzero_counts(should_cancel)?;
    let log_coverage = coverage
        .iter()
        .copied()
        .filter(|value| value.is_finite() && *value > 0.0)
        .map(f64::ln)
        .collect::<Vec<_>>();
    let median_log = median(log_coverage.clone()).unwrap_or(f64::NEG_INFINITY);
    let deviations = log_coverage
        .into_iter()
        .map(|value| (value - median_log).abs())
        .collect::<Vec<_>>();
    let mad = median(deviations).unwrap_or(0.0);
    let coverage_threshold = if median_log.is_finite() && mad.is_finite() {
        (median_log - ICE_MAD_MAX * mad).exp()
    } else {
        0.0
    };

    Ok(coverage
        .iter()
        .zip(nonzero_counts)
        .map(|(value, nonzero_count)| {
            value.is_finite()
                && *value > 0.0
                && *value >= coverage_threshold
                && nonzero_count >= ICE_MIN_NONZERO_CONTACTS
        })
        .collect())
}

fn positive_coverage_percentile(coverage: &[f64], percentile: f64) -> f64 {
    if percentile <= 0.0 {
        return 0.0;
    }
    let mut positive = coverage
        .iter()
        .copied()
        .filter(|value| value.is_finite() && *value > 0.0)
        .collect::<Vec<_>>();
    if positive.is_empty() {
        return 0.0;
    }
    positive.sort_by(f64::total_cmp);
    let position = (percentile.clamp(0.0, 100.0) / 100.0) * positive.len().saturating_sub(1) as f64;
    let lower = position.floor() as usize;
    let upper = position.ceil() as usize;
    let fraction = position - lower as f64;
    positive[lower] + (positive[upper] - positive[lower]) * fraction
}

fn median(mut values: Vec<f64>) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    values.sort_by(f64::total_cmp);
    let middle = values.len() / 2;
    if values.len() % 2 == 0 {
        Some((values[middle - 1] + values[middle]) / 2.0)
    } else {
        Some(values[middle])
    }
}

fn positive_mean(values: &[f64]) -> Option<f64> {
    let mut sum = 0.0;
    let mut count = 0_usize;
    for value in values {
        if value.is_finite() && *value > 0.0 {
            sum += *value;
            count += 1;
        }
    }
    (count > 0 && sum.is_finite()).then_some(sum / count as f64)
}

fn squared_norm(values: &[f64]) -> f64 {
    values.iter().map(|value| value * value).sum()
}

fn finite_positive_or_zero(value: f64) -> f64 {
    if value.is_finite() && value > 0.0 {
        value
    } else {
        0.0
    }
}

fn ensure_not_cancelled(should_cancel: &dyn Fn() -> bool) -> Result<()> {
    if should_cancel() {
        Err(Error::Cancelled)
    } else {
        Ok(())
    }
}

fn normalization_error(message: impl Into<String>) -> Error {
    Error::message(format!("normalization error: {}", message.into()))
}

#[cfg(test)]
mod tests {
    use super::{
        compute_cis_coverage_normalization_weights, compute_cis_coverage_pair_for_storage,
        compute_global_coverage_with_pool, compute_ice_from_shared_coverage,
        compute_ice_weights_for_storage, compute_kr_from_shared_coverage,
        compute_kr_weights_for_storage, compute_normalization_weights,
        compute_stored_normalizations_with_pool, knight_ruiz_attempt_with_active_bins,
        knight_ruiz_weights_with_active_bins, knight_ruiz_weights_with_compact_matrix,
        prebalance_compact_kr_warm_start, ActiveKrSupport, GlobalKrMatrix, KrAttemptOutcome,
        KrIterationStats, KrMatrixOperator, KrWarmStart, Normalization, SparseContactMatrix,
    };

    fn test_matrix() -> SparseContactMatrix {
        // [[4, 1, 2], [1, 3, 1], [2, 1, 5]] in symmetric-upper storage.
        SparseContactMatrix::new(
            3,
            vec![0, 0, 0, 1, 1, 2],
            vec![0, 1, 2, 1, 2, 2],
            vec![4.0, 1.0, 2.0, 3.0, 1.0, 5.0],
        )
        .expect("valid matrix")
    }

    fn symmetric_total(matrix: &SparseContactMatrix, weights: &[f64]) -> f64 {
        let mut total = 0.0;
        matrix
            .for_each_positive_pixel(&|| false, |first, second, count| {
                let symmetry = if first == second { 1.0 } else { 2.0 };
                total += symmetry * count * weights[first] * weights[second];
            })
            .expect("valid upper triangle");
        total
    }

    fn assert_weight_bits_equal(observed: &[f64], expected: &[f64]) {
        assert_eq!(observed.len(), expected.len());
        for (index, (observed, expected)) in observed.iter().zip(expected).enumerate() {
            assert!(
                (observed.is_nan() && expected.is_nan())
                    || observed.to_bits() == expected.to_bits(),
                "weight {index} differs: observed={observed:?} expected={expected:?}",
            );
        }
    }

    fn balanced_marginals(matrix: &SparseContactMatrix, weights: &[f64]) -> Vec<f64> {
        let product = matrix.multiply(weights, &|| false).expect("matrix product");
        weights
            .iter()
            .zip(product)
            .map(|(weight, value)| weight * value)
            .collect()
    }

    #[test]
    fn raw_weights_are_identity() {
        assert_eq!(
            compute_normalization_weights(&test_matrix(), Normalization::Raw, &|| false,)
                .expect("raw weights"),
            vec![1.0, 1.0, 1.0],
        );
    }

    #[test]
    fn global_kr_csr_active_mask_matches_the_symmetric_sparse_product() {
        let matrix = test_matrix();
        let support = ActiveKrSupport {
            global_bin_count: 3,
            active_bins: vec![0, 2],
        };
        let vector = vec![2.0, 3.0];
        let global = GlobalKrMatrix::from_sparse(&matrix, &|| false).expect("global KR matrix");
        // Parallel chunks must retain the original stable per-row order.
        assert_eq!(global.row_offsets, vec![0, 3, 6, 9]);
        assert_eq!(global.columns, vec![0, 1, 2, 0, 1, 2, 0, 1, 2]);
        assert_eq!(
            global.counts,
            vec![4.0, 1.0, 2.0, 1.0, 3.0, 1.0, 2.0, 1.0, 5.0]
        );
        let mut expanded = vec![0.0; 3];
        let mut observed = vec![0.0; 2];
        global
            .multiply_active_into(
                &support,
                &vector,
                &mut expanded,
                &mut observed,
                None,
                &|| false,
            )
            .expect("masked global product");

        // Active rows 0 and 2 retain [[4, 2], [2, 5]].
        assert_eq!(observed, vec![14.0, 19.0]);
    }

    #[test]
    fn compact_kr_csr_reuses_storage_and_matches_global_path_bitwise() {
        let matrix = test_matrix();
        let support = ActiveKrSupport {
            global_bin_count: 3,
            active_bins: vec![0, 2],
        };
        let global = GlobalKrMatrix::from_sparse(&matrix, &|| false).expect("global KR matrix");
        let mut global_stats = KrIterationStats::default();
        let expected = knight_ruiz_weights_with_active_bins(
            &matrix,
            &global,
            support.clone(),
            5_000,
            None,
            true,
            &|| false,
            &mut global_stats,
        )
        .expect("global KR weights");

        let compact = matrix
            .clone()
            .into_compact_kr(support, &|| false)
            .expect("compact KR matrix");
        assert_eq!(compact.row_offsets, vec![0, 2, 4]);
        assert_eq!(compact.columns, vec![0, 1, 0, 1]);
        assert_eq!(compact.counts, vec![4.0, 2.0, 2.0, 5.0]);
        let mut scratch = vec![0.0; compact.scratch_len()];
        let mut product = vec![0.0; compact.size()];
        compact
            .multiply_into(&[2.0, 3.0], &mut scratch, &mut product, None, &|| false)
            .expect("compact product");
        assert_eq!(product, vec![14.0, 19.0]);

        let mut compact_stats = KrIterationStats::default();
        let observed = knight_ruiz_weights_with_compact_matrix(
            &compact,
            5_000,
            None,
            true,
            &|| false,
            &mut compact_stats,
        )
        .expect("compact KR weights");
        assert_weight_bits_equal(&observed, &expected);
        assert_eq!(
            compact_stats.matrix_vector_products,
            global_stats.matrix_vector_products
        );
        assert_eq!(
            compact_stats.outer_iterations,
            global_stats.outer_iterations
        );
        assert_eq!(
            compact_stats.inner_iterations,
            global_stats.inner_iterations
        );
    }

    #[test]
    fn kr_warm_start_maps_partial_weights_by_global_bin() {
        let seed = KrWarmStart {
            active_bins: vec![0, 2, 4, 7],
            weights: vec![1.5, 2.5, 4.5, 7.5],
        };
        let support = ActiveKrSupport {
            global_bin_count: 8,
            active_bins: vec![2, 4, 6, 7],
        };

        assert_eq!(seed.for_support(&support), vec![2.5, 4.5, 1.0, 7.5]);
        let stabilized = seed.stabilized_for_support(&support);
        assert!(stabilized
            .iter()
            .all(|weight| weight.is_finite() && *weight >= 1e-8 && *weight <= 1e8));
        assert!(stabilized[2] < stabilized[0]);
        assert!(stabilized[0] < stabilized[1]);
        assert!(stabilized[1] < stabilized[3]);
    }

    #[test]
    fn kr_support_prunes_a_degree_one_leaf_but_keeps_the_scalable_core() {
        // Bin 0 has only one edge into hub bin 1. Its unit row equation would
        // consume bin 1's full marginal even though bin 1 also contacts bin 2.
        let matrix = SparseContactMatrix::new(
            3,
            vec![0, 1, 1, 2],
            vec![1, 1, 2, 2],
            vec![1.0, 2.0, 1.0, 2.0],
        )
        .expect("valid leaf-to-core matrix");
        let coverage = matrix.row_sums(&|| false).expect("coverage");
        let global = GlobalKrMatrix::from_sparse(&matrix, &|| false).expect("global KR matrix");
        let support = global
            .active_support(&coverage, 0.0, None, &|| false)
            .expect("active support");
        assert_eq!(support.active_bins, vec![1, 2]);
    }

    #[test]
    fn compact_prebalance_reduces_the_warm_start_residual() {
        let matrix = test_matrix();
        let support = ActiveKrSupport {
            global_bin_count: matrix.bin_count,
            active_bins: vec![0, 1, 2],
        };
        let compact = matrix
            .into_compact_kr(support, &|| false)
            .expect("compact KR matrix");
        let mut initial = vec![0.1, 5.0, 0.2];
        let residual = |weights: &[f64]| {
            let mut product = vec![0.0; weights.len()];
            compact
                .multiply_rows(weights, &mut product, None, &|| false)
                .expect("compact product");
            weights
                .iter()
                .zip(product)
                .map(|(weight, product)| (1.0 - weight * product).powi(2))
                .sum::<f64>()
        };
        let before = residual(&initial);
        assert_eq!(
            prebalance_compact_kr_warm_start(&compact, &mut initial, 8, None, &|| false)
                .expect("warm-start prebalance"),
            8,
        );
        assert!(residual(&initial) < before);
    }

    #[test]
    fn kr_budget_exhaustion_can_resume_to_the_same_balanced_solution() {
        let matrix = test_matrix();
        let global = GlobalKrMatrix::from_sparse(&matrix, &|| false).expect("global KR matrix");
        let support = ActiveKrSupport {
            global_bin_count: matrix.bin_count,
            active_bins: vec![0, 1, 2],
        };
        let mut partial_stats = KrIterationStats::default();
        let partial = knight_ruiz_attempt_with_active_bins(
            &matrix,
            &global,
            support.clone(),
            vec![1.0; 3],
            false,
            2,
            None,
            false,
            &|| false,
            &mut partial_stats,
        )
        .expect("bounded KR attempt");
        let KrAttemptOutcome::BudgetExhausted(seed) = partial else {
            panic!("two MVPs should only produce a partial KR iterate");
        };
        assert_eq!(seed.active_bins, support.active_bins);
        assert!(seed
            .weights
            .iter()
            .all(|weight| weight.is_finite() && *weight > 0.0));
        assert!(seed.weights.iter().any(|weight| *weight != 1.0));

        let mut resumed_stats = KrIterationStats::default();
        let resumed = knight_ruiz_attempt_with_active_bins(
            &matrix,
            &global,
            support,
            seed.weights,
            true,
            5_000,
            None,
            true,
            &|| false,
            &mut resumed_stats,
        )
        .expect("resumed KR attempt");
        let KrAttemptOutcome::Converged(resumed) = resumed else {
            panic!("resumed KR should converge");
        };
        let expected = compute_kr_weights_for_storage(&matrix, &|| false)
            .expect("cold-start KR")
            .weights;
        for (resumed, expected) in resumed.iter().zip(expected) {
            let relative_error = (resumed / expected - 1.0).abs();
            assert!(
                relative_error < 1e-5,
                "resumed KR weight differs by {relative_error}"
            );
        }
    }

    #[test]
    fn global_kr_csr_observes_cancellation() {
        let matrix = test_matrix();
        assert!(matches!(
            GlobalKrMatrix::from_sparse(&matrix, &|| true),
            Err(crate::error::Error::Cancelled)
        ));
    }

    #[test]
    fn kr_active_support_drops_rows_isolated_by_coverage_filtering() {
        let matrix = SparseContactMatrix::new(
            6,
            vec![0, 2, 2, 2],
            vec![1, 3, 4, 5],
            vec![20.0, 4.0, 4.0, 4.0],
        )
        .expect("valid sparse matrix");
        let coverage = matrix.row_sums(&|| false).expect("coverage");
        let global = GlobalKrMatrix::from_sparse(&matrix, &|| false).expect("global KR matrix");
        let support = global
            .active_support(&coverage, 10.0, None, &|| false)
            .expect("active support");

        // Bin 2 exceeds the threshold in the original matrix, but every one of
        // its neighbors is filtered out. It must not become a zero row in BNEWT.
        assert_eq!(support.active_bins, vec![0, 1]);
        assert_eq!(support.global_bin_count, 6);
    }

    #[test]
    fn vc_and_vc_sqrt_preserve_the_valid_matrix_total() {
        let matrix = test_matrix();
        let raw_total = symmetric_total(&matrix, &[1.0, 1.0, 1.0]);
        for normalization in [Normalization::Vc, Normalization::VcSqrt] {
            let weights = compute_normalization_weights(&matrix, normalization, &|| false)
                .expect("coverage normalization");
            assert!((symmetric_total(&matrix, &weights) - raw_total).abs() < 1e-9);
        }
    }

    #[test]
    fn cis_coverage_vectors_ignore_inter_chromosome_contacts() {
        let without_inter = SparseContactMatrix::new(
            4,
            vec![0, 0, 1, 2, 2, 3],
            vec![0, 1, 1, 2, 3, 3],
            vec![4.0, 2.0, 3.0, 5.0, 1.0, 2.0],
        )
        .expect("valid cis matrix");
        let with_inter = SparseContactMatrix::new(
            4,
            vec![0, 0, 0, 1, 1, 2, 2, 3],
            vec![0, 1, 2, 1, 3, 2, 3, 3],
            vec![4.0, 2.0, 100.0, 3.0, 50.0, 5.0, 1.0, 2.0],
        )
        .expect("valid assembly matrix");
        let chromosomes = [0, 0, 1, 1];
        for normalization in [Normalization::Vc, Normalization::VcSqrt] {
            let expected = compute_cis_coverage_normalization_weights(
                &without_inter,
                &chromosomes,
                2,
                normalization,
                &|| false,
            )
            .expect("cis coverage weights");
            let observed = compute_cis_coverage_normalization_weights(
                &with_inter,
                &chromosomes,
                2,
                normalization,
                &|| false,
            )
            .expect("assembly cis coverage weights");
            assert_eq!(observed, expected);
        }
    }

    #[test]
    fn fused_stored_normalizations_match_individual_calculations_exactly() {
        let matrix = test_matrix();
        let chromosomes = [0, 0, 1];
        let expected_ice =
            compute_ice_weights_for_storage(&matrix, &|| false).expect("individual ICE");
        let expected_kr =
            compute_kr_weights_for_storage(&matrix, &|| false).expect("individual KR");
        let expected_vc = compute_cis_coverage_normalization_weights(
            &matrix,
            &chromosomes,
            2,
            Normalization::Vc,
            &|| false,
        )
        .expect("individual VC");
        let expected_vc_sqrt = compute_cis_coverage_normalization_weights(
            &matrix,
            &chromosomes,
            2,
            Normalization::VcSqrt,
            &|| false,
        )
        .expect("individual VC_SQRT");
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(2)
            .build()
            .expect("test worker pool");
        let mut phases = Vec::new();

        let observed = compute_stored_normalizations_with_pool(
            &matrix,
            &chromosomes,
            2,
            &pool,
            &|| false,
            |normalization| phases.push(normalization),
        )
        .expect("fused normalizations");

        assert_eq!(
            phases,
            vec![
                Normalization::Ice,
                Normalization::Kr,
                Normalization::Vc,
                Normalization::VcSqrt,
            ]
        );
        assert_eq!(observed.ice.converged, expected_ice.converged);
        assert_eq!(
            observed.ice.relative_variance.to_bits(),
            expected_ice.relative_variance.to_bits()
        );
        assert_eq!(
            observed.kr.coverage_percentile.to_bits(),
            expected_kr.coverage_percentile.to_bits()
        );
        assert_weight_bits_equal(&observed.ice.weights, &expected_ice.weights);
        assert_weight_bits_equal(&observed.kr.weights, &expected_kr.weights);
        assert_weight_bits_equal(&observed.vc, &expected_vc);
        assert_weight_bits_equal(&observed.vc_sqrt, &expected_vc_sqrt);

        let coverage =
            compute_global_coverage_with_pool(&matrix, &pool, &|| false).expect("shared coverage");
        let staged_ice = compute_ice_from_shared_coverage(&matrix, &coverage, &pool, &|| false)
            .expect("staged ICE");
        let staged_kr = compute_kr_from_shared_coverage(&matrix, &coverage, &pool, &|| false)
            .expect("staged KR");
        let (staged_vc, staged_vc_sqrt) =
            compute_cis_coverage_pair_for_storage(&matrix, &chromosomes, 2, &|| false)
                .expect("staged VC pair");
        assert_weight_bits_equal(&staged_ice.weights, &expected_ice.weights);
        assert_weight_bits_equal(&staged_kr.weights, &expected_kr.weights);
        assert_weight_bits_equal(&staged_vc, &expected_vc);
        assert_weight_bits_equal(&staged_vc_sqrt, &expected_vc_sqrt);
    }

    #[test]
    fn ice_and_kr_balance_marginals_and_preserve_total() {
        let matrix = test_matrix();
        let raw_total = symmetric_total(&matrix, &[1.0, 1.0, 1.0]);
        for normalization in [Normalization::Ice, Normalization::Kr] {
            let weights = compute_normalization_weights(&matrix, normalization, &|| false)
                .expect("balanced normalization");
            let marginals = balanced_marginals(&matrix, &weights);
            let mean = marginals.iter().sum::<f64>() / marginals.len() as f64;
            let maximum_relative_error = marginals
                .iter()
                .map(|value| (value / mean - 1.0).abs())
                .fold(0.0_f64, f64::max);
            assert!(
                maximum_relative_error < 5e-3,
                "{normalization:?} marginal error {maximum_relative_error}",
            );
            assert!((symmetric_total(&matrix, &weights) - raw_total).abs() < 1e-8);
        }
    }

    #[test]
    fn ice_rejects_a_matrix_that_does_not_converge() {
        let matrix = SparseContactMatrix::new(5, vec![0, 0, 0, 0], vec![1, 2, 3, 4], vec![1.0; 4])
            .expect("valid star matrix");

        let error = compute_normalization_weights(&matrix, Normalization::Ice, &|| false)
            .expect_err("an unbalanceable matrix must not be labeled as ICE-normalized");
        assert!(error.to_string().contains("did not converge"));
    }

    #[test]
    fn kr_keeps_all_positive_bins_when_the_full_matrix_converges() {
        let bin_count = 1_000_usize;
        let bins = (0..bin_count as u64).collect::<Vec<_>>();
        let counts = (1..=bin_count).map(|value| value as f64).collect();
        let matrix = SparseContactMatrix::new(bin_count, bins.clone(), bins, counts)
            .expect("valid positive diagonal matrix");

        let weights = compute_normalization_weights(&matrix, Normalization::Kr, &|| false)
            .expect("full positive matrix should converge without percentile filtering");
        assert!(weights
            .iter()
            .all(|weight| weight.is_finite() && *weight > 0.0));
    }

    #[test]
    fn zero_coverage_bins_are_masked() {
        let matrix =
            SparseContactMatrix::new(3, vec![0], vec![1], vec![2.0]).expect("valid sparse matrix");
        for normalization in [
            Normalization::Ice,
            Normalization::Kr,
            Normalization::Vc,
            Normalization::VcSqrt,
        ] {
            let weights = compute_normalization_weights(&matrix, normalization, &|| false)
                .expect("normalization weights");
            assert!(weights[0].is_finite());
            assert!(weights[1].is_finite());
            assert!(weights[2].is_nan());
        }
    }

    #[test]
    fn cancellation_stops_before_calculation() {
        let error = compute_normalization_weights(&test_matrix(), Normalization::Kr, &|| true)
            .expect_err("cancelled normalization");
        assert_eq!(error, crate::error::Error::Cancelled);
    }

    #[test]
    fn rejects_pixels_outside_the_bin_table() {
        let error = SparseContactMatrix::new(1, vec![0], vec![1], vec![1.0])
            .expect_err("invalid pixel bin");
        assert!(error.to_string().contains("outside 1 bins"));
    }
}
