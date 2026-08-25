/*
 * Portions of this file are adapted from Juicebox's
 * NormalizationCalculations.java at upstream revision
 * 9697464526f6474ea3cc4f10b4269929e4fd72fe:
 * https://github.com/aidenlab/Juicebox/blob/9697464526f6474ea3cc4f10b4269929e4fd72fe/src/juicebox/tools/utils/norm/NormalizationCalculations.java
 *
 * The Rust implementation has been rewritten and modified for C-Studio.
 *
 * The MIT License (MIT)
 *
 * Copyright (c) 2011-2021 Broad Institute, Aiden Lab, Rice University,
 * Baylor College of Medicine
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NON-INFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

use crate::{CStudioError, CStudioResult};
use rayon::prelude::*;
use std::{
    cell::UnsafeCell,
    mem::{ManuallyDrop, MaybeUninit},
    sync::OnceLock,
};

const NUMERIC_EPSILON: f64 = 1e-15;
const ICE_TOLERANCE: f64 = 1e-5;
const ICE_MAX_ITERATIONS: usize = 200;
const ICE_MIN_NONZERO_CONTACTS: usize = 10;
const ICE_MAD_MAX: f64 = 5.0;
const KR_TOLERANCE: f64 = 1e-6;
const KR_MAX_OUTER_ITERATIONS: usize = 100;
const KR_MAX_INNER_ITERATIONS: usize = 200;
// Juicebox does not impose a matrix-vector-product ceiling; it stops after the
// residual ceases to improve. Keep a high defensive ceiling for malformed maps
// without cutting off valid large assembly matrices prematurely.
const KR_MAX_MATRIX_VECTOR_PRODUCTS: usize = 5_000;
const KR_MAX_RETRY_MATRIX_VECTOR_PRODUCTS: usize = 64;
const KR_RETRY_PERCENTILES: [f64; 6] = [0.0, 1.0, 2.0, 3.0, 4.0, 10.0];
const PARALLEL_KR_PIXEL_THRESHOLD: usize = 250_000;
const MAX_KR_WORKER_THREADS: usize = 8;
static KR_THREAD_POOL: OnceLock<Option<rayon::ThreadPool>> = OnceLock::new();

fn kr_thread_pool() -> Option<&'static rayon::ThreadPool> {
    KR_THREAD_POOL
        .get_or_init(|| {
            let threads = std::thread::available_parallelism()
                .map_or(1, usize::from)
                .clamp(1, MAX_KR_WORKER_THREADS);
            rayon::ThreadPoolBuilder::new()
                .num_threads(threads)
                .thread_name(|index| format!("cstudio-kr-{index}"))
                .build()
                .ok()
        })
        .as_ref()
}

fn run_in_kr_pool<T: Send>(operation: impl FnOnce() -> T + Send) -> T {
    match kr_thread_pool() {
        Some(pool) => pool.install(operation),
        None => operation(),
    }
}

/// Contact-map normalization selected by the UI and used in cache identities.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
pub enum ContactNormalization {
    #[default]
    Raw,
    Ice,
    Kr,
    Vc,
    VcSqrt,
}

impl ContactNormalization {
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

/// Compact symmetric-upper sparse matrix used to calculate global norm vectors.
#[derive(Debug, Clone)]
pub struct SparseContactMatrix {
    bin_count: usize,
    bin1: Vec<u32>,
    bin2: Vec<u32>,
    counts: Vec<f64>,
}

/// One whole-assembly symmetric CSR retained across every percentile retry.
/// Percentile filtering changes only `ActiveKrSupport`; the adjacency and its
/// stable per-row floating-point accumulation order never need to be rebuilt.
struct GlobalKrMatrix {
    row_offsets: Vec<usize>,
    columns: Vec<u32>,
    counts: Vec<f64>,
}

struct ActiveKrSupport {
    /// Global active mask rebuilt for each coverage percentile.
    active: Vec<u8>,
    /// Compact active-vector position -> global bin.
    active_bins: Vec<usize>,
}

/// Parallel writers own disjoint slots computed before the fill begins. The
/// backing allocation remains `MaybeUninit`, so cancellation or panic can drop
/// a partially filled buffer without attempting to drop uninitialized values.
struct ParallelInitVec<T> {
    values: Vec<UnsafeCell<MaybeUninit<T>>>,
}

// Each output index is assigned to exactly one deterministic input chunk.
unsafe impl<T: Send> Sync for ParallelInitVec<T> {}

impl<T> ParallelInitVec<T> {
    fn with_len(len: usize) -> Self {
        let mut values = Vec::with_capacity(len);
        values.resize_with(len, || UnsafeCell::new(MaybeUninit::uninit()));
        Self { values }
    }

    fn write(&self, index: usize, value: T) {
        // SAFETY: `GlobalKrMatrix::from_sparse` assigns non-overlapping ranges
        // to worker chunks for every row, so no slot is written more than once.
        unsafe {
            (*self.values[index].get()).write(value);
        }
    }

    unsafe fn assume_init(self) -> Vec<T> {
        let mut this = ManuallyDrop::new(self);
        let pointer = this.values.as_mut_ptr().cast::<T>();
        let len = this.values.len();
        let capacity = this.values.capacity();
        // SAFETY: UnsafeCell and MaybeUninit are representation-transparent,
        // and the caller verifies that every assigned output slot was written.
        unsafe { Vec::from_raw_parts(pointer, len, capacity) }
    }
}

impl GlobalKrMatrix {
    fn from_sparse(
        matrix: &SparseContactMatrix,
        should_cancel: &dyn Fn() -> bool,
    ) -> CStudioResult<Self> {
        ensure_not_cancelled(should_cancel)?;
        let started = std::time::Instant::now();
        let row_count = matrix.bin_count;
        let pixel_count = matrix.counts.len();
        let worker_count = kr_thread_pool()
            .map_or(1, rayon::ThreadPool::current_num_threads)
            .min(pixel_count.max(1));
        let chunk_size = pixel_count.div_ceil(worker_count);

        // Per-worker row counts avoid contended atomics. Workers own contiguous
        // input chunks; those same counts become deterministic output cursors.
        let mut worker_row_counts = run_in_kr_pool(|| {
            (0..worker_count)
                .into_par_iter()
                .map(|worker| {
                    let start = worker.saturating_mul(chunk_size).min(pixel_count);
                    let end = start.saturating_add(chunk_size).min(pixel_count);
                    let mut row_counts = vec![0_u32; row_count];
                    for pixel in start..end {
                        let count = matrix.counts[pixel];
                        if !count.is_finite() || count <= 0.0 {
                            continue;
                        }
                        let first = matrix.bin1[pixel] as usize;
                        let second = matrix.bin2[pixel] as usize;
                        row_counts[first] += 1;
                        if first != second {
                            row_counts[second] += 1;
                        }
                    }
                    row_counts
                })
                .collect::<Vec<_>>()
        });
        ensure_not_cancelled(should_cancel)?;

        let row_lengths = run_in_kr_pool(|| {
            (0..row_count)
                .into_par_iter()
                .map(|row| {
                    worker_row_counts
                        .iter()
                        .map(|counts| counts[row] as usize)
                        .sum::<usize>()
                })
                .collect::<Vec<_>>()
        });

        let mut row_offsets = Vec::with_capacity(row_count.saturating_add(1));
        row_offsets.push(0_usize);
        for row_length in row_lengths {
            let next = row_offsets
                .last()
                .copied()
                .unwrap_or(0)
                .checked_add(row_length)
                .ok_or_else(|| normalization_error("KR CSR entry count overflowed"))?;
            row_offsets.push(next);
        }
        let entry_count = row_offsets.last().copied().unwrap_or(0);
        if entry_count > u32::MAX as usize {
            // Column indexes remain u32 because normalization itself supports at
            // most u32::MAX bins. Entry count can exceed that on unusually dense
            // maps, but this guard avoids an impractical transient allocation.
            return Err(normalization_error(
                "KR CSR matrix exceeds the supported entry count",
            ));
        }
        // Convert each worker's row counts to absolute output cursors. Earlier
        // input chunks always receive earlier row slots, preserving the exact
        // order of a single-threaded stable CSR fill.
        let mut next_row_entry = row_offsets[..row_count]
            .iter()
            .map(|offset| *offset as u32)
            .collect::<Vec<_>>();
        for worker_cursors in &mut worker_row_counts {
            for row in 0..row_count {
                let row_count = worker_cursors[row];
                worker_cursors[row] = next_row_entry[row];
                next_row_entry[row] = next_row_entry[row].saturating_add(row_count);
            }
        }
        if next_row_entry
            .iter()
            .zip(&row_offsets[1..])
            .any(|(observed, expected)| *observed as usize != *expected)
        {
            return Err(normalization_error(
                "parallel KR CSR row assignment was incomplete",
            ));
        }

        let columns = ParallelInitVec::<u32>::with_len(entry_count);
        let counts = ParallelInitVec::<f64>::with_len(entry_count);
        run_in_kr_pool(|| {
            worker_row_counts
                .into_par_iter()
                .enumerate()
                .for_each(|(worker, mut cursors)| {
                    let start = worker.saturating_mul(chunk_size).min(pixel_count);
                    let end = start.saturating_add(chunk_size).min(pixel_count);
                    for pixel in start..end {
                        let count = matrix.counts[pixel];
                        if !count.is_finite() || count <= 0.0 {
                            continue;
                        }
                        let first = matrix.bin1[pixel] as usize;
                        let second = matrix.bin2[pixel] as usize;
                        let first_entry = cursors[first] as usize;
                        columns.write(first_entry, second as u32);
                        counts.write(first_entry, count);
                        cursors[first] += 1;
                        if first != second {
                            let second_entry = cursors[second] as usize;
                            columns.write(second_entry, first as u32);
                            counts.write(second_entry, count);
                            cursors[second] += 1;
                        }
                    }
                });
        });
        ensure_not_cancelled(should_cancel)?;

        // SAFETY: row totals were verified before the fill; every worker writes
        // exactly its pre-counted positive pixels into disjoint output slots.
        let columns = unsafe { columns.assume_init() };
        let counts = unsafe { counts.assume_init() };

        if std::env::var("CSTUDIO_PERF_LOG").as_deref() == Ok("1") {
            eprintln!(
                "CSTUDIO_PERF event=kr_global_csr status=complete bins={} source_pixels={} symmetric_entries={} workers={} elapsed_ms={}",
                row_count,
                pixel_count,
                entry_count,
                worker_count,
                started.elapsed().as_millis(),
            );
        }

        Ok(Self {
            row_offsets,
            columns,
            counts,
        })
    }

    fn active_support(
        &self,
        coverage: &[f64],
        coverage_threshold: f64,
        should_cancel: &dyn Fn() -> bool,
    ) -> CStudioResult<ActiveKrSupport> {
        if coverage.len() + 1 != self.row_offsets.len() {
            return Err(normalization_error(
                "KR coverage and global CSR have different bin counts",
            ));
        }
        ensure_not_cancelled(should_cancel)?;
        let candidates = run_in_kr_pool(|| {
            coverage
                .par_iter()
                .map(|value| u8::from(value.is_finite() && *value > coverage_threshold))
                .collect::<Vec<_>>()
        });
        let active = run_in_kr_pool(|| {
            (0..coverage.len())
                .into_par_iter()
                .map(|row| {
                    if candidates[row] == 0 {
                        return 0_u8;
                    }
                    u8::from(
                        (self.row_offsets[row]..self.row_offsets[row + 1])
                            .any(|entry| candidates[self.columns[entry] as usize] != 0),
                    )
                })
                .collect::<Vec<_>>()
        });
        ensure_not_cancelled(should_cancel)?;

        let active_bins = run_in_kr_pool(|| {
            active
                .par_iter()
                .enumerate()
                .filter_map(|(bin, is_active)| (*is_active != 0).then_some(bin))
                .collect::<Vec<_>>()
        });
        Ok(ActiveKrSupport {
            active,
            active_bins,
        })
    }

    fn multiply_active_into(
        &self,
        support: &ActiveKrSupport,
        vector: &[f64],
        expanded_vector: &mut [f64],
        product: &mut [f64],
        should_cancel: &dyn Fn() -> bool,
    ) -> CStudioResult<()> {
        if product.len() != vector.len()
            || support.active_bins.len() != vector.len()
            || support.active.len() + 1 != self.row_offsets.len()
            || expanded_vector.len() + 1 != self.row_offsets.len()
        {
            return Err(normalization_error(
                "KR matrix product buffer has the wrong length",
            ));
        }
        ensure_not_cancelled(should_cancel)?;
        expanded_vector.fill(0.0);
        for (compact_bin, global_bin) in support.active_bins.iter().copied().enumerate() {
            expanded_vector[global_bin] = vector[compact_bin];
        }
        let multiply_row = |row: usize| {
            let mut sum = 0.0;
            let global_row = support.active_bins[row];
            for entry in self.row_offsets[global_row]..self.row_offsets[global_row + 1] {
                sum += self.counts[entry] * expanded_vector[self.columns[entry] as usize];
            }
            sum
        };
        if self.counts.len() >= PARALLEL_KR_PIXEL_THRESHOLD {
            run_in_kr_pool(|| {
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
}

impl SparseContactMatrix {
    pub fn new(
        bin_count: usize,
        bin1: Vec<u64>,
        bin2: Vec<u64>,
        counts: Vec<f64>,
    ) -> CStudioResult<Self> {
        if bin1.len() != bin2.len() || bin1.len() != counts.len() {
            return Err(normalization_error(
                "pixel bin1, bin2, and count arrays have different lengths",
            ));
        }
        if bin_count > u32::MAX as usize {
            return Err(normalization_error(format!(
                "{bin_count} bins exceed the supported normalization index range",
            )));
        }

        let mut compact_bin1 = Vec::with_capacity(bin1.len());
        let mut compact_bin2 = Vec::with_capacity(bin2.len());
        for (pixel_index, (first, second)) in bin1.into_iter().zip(bin2).enumerate() {
            if first >= bin_count as u64 || second >= bin_count as u64 {
                return Err(normalization_error(format!(
                    "pixel {pixel_index} references bin ({first}, {second}) outside {bin_count} bins",
                )));
            }
            compact_bin1.push(first as u32);
            compact_bin2.push(second as u32);
        }

        Ok(Self {
            bin_count,
            bin1: compact_bin1,
            bin2: compact_bin2,
            counts,
        })
    }

    fn row_sums(&self, should_cancel: &dyn Fn() -> bool) -> CStudioResult<Vec<f64>> {
        let mut sums = vec![0.0; self.bin_count];
        self.for_each_positive_pixel(should_cancel, |first, second, count| {
            sums[first] += count;
            if first != second {
                sums[second] += count;
            }
        })?;
        Ok(sums)
    }

    fn row_nonzero_counts(&self, should_cancel: &dyn Fn() -> bool) -> CStudioResult<Vec<usize>> {
        let mut counts = vec![0_usize; self.bin_count];
        self.for_each_positive_pixel(should_cancel, |first, second, _| {
            counts[first] += 1;
            if first != second {
                counts[second] += 1;
            }
        })?;
        Ok(counts)
    }

    fn multiply(
        &self,
        vector: &[f64],
        should_cancel: &dyn Fn() -> bool,
    ) -> CStudioResult<Vec<f64>> {
        let mut product = vec![0.0; self.bin_count];
        self.for_each_positive_pixel(should_cancel, |first, second, count| {
            let first_weight = finite_positive_or_zero(vector[first]);
            let second_weight = finite_positive_or_zero(vector[second]);
            product[first] += count * second_weight;
            if first != second {
                product[second] += count * first_weight;
            }
        })?;
        Ok(product)
    }

    fn for_each_positive_pixel(
        &self,
        should_cancel: &dyn Fn() -> bool,
        mut visit: impl FnMut(usize, usize, f64),
    ) -> CStudioResult<()> {
        ensure_not_cancelled(should_cancel)?;
        for pixel_index in 0..self.counts.len() {
            if pixel_index % 16_384 == 0 {
                ensure_not_cancelled(should_cancel)?;
            }
            let count = self.counts[pixel_index];
            if count.is_finite() && count > 0.0 {
                visit(
                    self.bin1[pixel_index] as usize,
                    self.bin2[pixel_index] as usize,
                    count,
                );
            }
        }
        ensure_not_cancelled(should_cancel)
    }
}

/// Calculate one global multiplicative vector (`Nij = Oij * wi * wj`).
pub fn compute_normalization_weights(
    matrix: &SparseContactMatrix,
    normalization: ContactNormalization,
    should_cancel: &dyn Fn() -> bool,
) -> CStudioResult<Vec<f64>> {
    ensure_not_cancelled(should_cancel)?;
    match normalization {
        ContactNormalization::Raw => Ok(vec![1.0; matrix.bin_count]),
        ContactNormalization::Vc => coverage_weights(matrix, false, should_cancel),
        ContactNormalization::VcSqrt => coverage_weights(matrix, true, should_cancel),
        ContactNormalization::Ice => ice_weights(matrix, should_cancel),
        ContactNormalization::Kr => knight_ruiz_weights(matrix, should_cancel),
    }
}

fn coverage_weights(
    matrix: &SparseContactMatrix,
    square_root: bool,
    should_cancel: &dyn Fn() -> bool,
) -> CStudioResult<Vec<f64>> {
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

fn ice_weights(
    matrix: &SparseContactMatrix,
    should_cancel: &dyn Fn() -> bool,
) -> CStudioResult<Vec<f64>> {
    let coverage = matrix.row_sums(should_cancel)?;
    if !coverage
        .iter()
        .any(|value| value.is_finite() && *value > 0.0)
    {
        return Ok(vec![f64::NAN; matrix.bin_count]);
    }
    let active = ice_active_bins(matrix, &coverage, should_cancel)?;
    let mut weights = active
        .into_iter()
        .map(|is_active| if is_active { 1.0 } else { f64::NAN })
        .collect::<Vec<_>>();
    let mut converged = false;
    let mut last_variance = f64::INFINITY;

    for _ in 0..ICE_MAX_ITERATIONS {
        ensure_not_cancelled(should_cancel)?;
        let product = matrix.multiply(&weights, should_cancel)?;
        let marginals = weights
            .iter()
            .zip(product.iter())
            .map(|(weight, value)| weight * value)
            .collect::<Vec<_>>();
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

        for (weight, marginal) in weights.iter_mut().zip(marginals) {
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
        let product = matrix.multiply(&weights, should_cancel)?;
        let marginals = weights
            .iter()
            .zip(product.iter())
            .map(|(weight, value)| weight * value)
            .collect::<Vec<_>>();
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
    if !converged {
        return Err(normalization_error(format!(
            "ICE did not converge within {ICE_MAX_ITERATIONS} iterations (relative marginal variance {last_variance:.6e})",
        )));
    }

    rescale_weights_to_preserve_total(matrix, &mut weights, should_cancel)?;
    Ok(weights)
}

fn knight_ruiz_weights(
    matrix: &SparseContactMatrix,
    should_cancel: &dyn Fn() -> bool,
) -> CStudioResult<Vec<f64>> {
    let coverage = matrix.row_sums(should_cancel)?;
    if !coverage
        .iter()
        .any(|value| value.is_finite() && *value > 0.0)
    {
        return Ok(vec![f64::NAN; matrix.bin_count]);
    }
    let global_matrix = GlobalKrMatrix::from_sparse(matrix, should_cancel)?;

    let mut last_error = None;
    let mut previous_active_count = None;
    for (retry_index, percentile) in KR_RETRY_PERCENTILES.into_iter().enumerate() {
        ensure_not_cancelled(should_cancel)?;
        let attempt_started = std::time::Instant::now();
        let coverage_threshold = positive_coverage_percentile(&coverage, percentile);
        let support_started = std::time::Instant::now();
        let support = global_matrix.active_support(&coverage, coverage_threshold, should_cancel)?;
        let support_ms = support_started.elapsed().as_millis();
        let active_count = support.active_bins.len();
        if previous_active_count == Some(active_count) {
            continue;
        }
        previous_active_count = Some(active_count);
        let matrix_vector_product_limit = if retry_index + 1 == KR_RETRY_PERCENTILES.len() {
            KR_MAX_MATRIX_VECTOR_PRODUCTS
        } else {
            // Failed low-percentile attempts are deliberately bounded so a
            // sparse map cannot spend the full KR budget six times before
            // reaching Juicebox's final 10% support retry.
            KR_MAX_RETRY_MATRIX_VECTOR_PRODUCTS
        };
        match knight_ruiz_weights_with_active_bins(
            matrix,
            &global_matrix,
            support,
            matrix_vector_product_limit,
            should_cancel,
        ) {
            Ok(weights) => {
                if std::env::var("CSTUDIO_PERF_LOG").as_deref() == Ok("1") {
                    eprintln!(
                        "CSTUDIO_PERF event=kr_attempt status=ok percentile={} active_bins={} mvp_limit={} support_ms={} elapsed_ms={}",
                        percentile,
                        active_count,
                        matrix_vector_product_limit,
                        support_ms,
                        attempt_started.elapsed().as_millis(),
                    );
                }
                return Ok(weights);
            }
            Err(CStudioError::RequestCancelled) => return Err(CStudioError::RequestCancelled),
            Err(error) => {
                if std::env::var("CSTUDIO_PERF_LOG").as_deref() == Ok("1") {
                    eprintln!(
                        "CSTUDIO_PERF event=kr_attempt status=failed percentile={} active_bins={} mvp_limit={} support_ms={} elapsed_ms={} error={}",
                        percentile,
                        active_count,
                        matrix_vector_product_limit,
                        support_ms,
                        attempt_started.elapsed().as_millis(),
                        error,
                    );
                }
                last_error = Some(error);
            }
        }
    }

    Err(last_error.unwrap_or_else(|| normalization_error("KR could not select any active bins")))
}

fn knight_ruiz_weights_with_active_bins(
    matrix: &SparseContactMatrix,
    global_matrix: &GlobalKrMatrix,
    support: ActiveKrSupport,
    matrix_vector_product_limit: usize,
    should_cancel: &dyn Fn() -> bool,
) -> CStudioResult<Vec<f64>> {
    if support.active_bins.is_empty() {
        return Err(normalization_error("KR could not select any active bins"));
    }

    let compact = knight_ruiz_bnewt(
        global_matrix,
        &support,
        // Juicebox BNEWT starts from the all-ones vector. A coverage-scaled
        // initial vector looks algebraically equivalent, but it changes the
        // inexact Newton stopping sequence and can exhaust the iteration budget
        // on large assembly maps before reaching the same solution.
        vec![1.0; support.active_bins.len()],
        matrix_vector_product_limit,
        should_cancel,
    )?;
    let mut weights = vec![f64::NAN; matrix.bin_count];
    for (compact_index, bin) in support.active_bins.into_iter().enumerate() {
        let value = compact[compact_index];
        if value.is_finite() && value > 0.0 {
            weights[bin] = value;
        }
    }
    rescale_weights_to_preserve_total(matrix, &mut weights, should_cancel)?;
    Ok(weights)
}

fn knight_ruiz_bnewt(
    global_matrix: &GlobalKrMatrix,
    support: &ActiveKrSupport,
    mut x: Vec<f64>,
    matrix_vector_product_limit: usize,
    should_cancel: &dyn Fn() -> bool,
) -> CStudioResult<Vec<f64>> {
    let size = x.len();
    // Juicebox's BNEWT stopping condition is a global L2 residual, not an RMS
    // residual that becomes progressively looser as the matrix grows.
    let residual_target = KR_TOLERANCE * KR_TOLERANCE;
    let delta = 0.1;
    let gamma_coefficient = 0.9;
    let eta_max = 0.1;
    let mut eta = eta_max;
    let mut matrix_vector_products = 0_usize;

    // Reuse one global-bin scratch vector for every matrix-vector product.
    // Inactive columns stay zero, so percentile retries only replace the mask
    // and active-bin list; the global CSR is never filtered or rebuilt.
    let mut expanded_vector = vec![0.0; global_matrix.row_offsets.len().saturating_sub(1)];
    let mut v = vec![0.0; size];
    global_matrix.multiply_active_into(support, &x, &mut expanded_vector, &mut v, should_cancel)?;
    matrix_vector_products += 1;
    for index in 0..size {
        v[index] *= x[index];
        if !v[index].is_finite() || v[index] <= NUMERIC_EPSILON {
            return Err(normalization_error(
                "KR encountered a zero or non-finite active marginal",
            ));
        }
    }
    let mut residual = v.iter().map(|value| 1.0 - value).collect::<Vec<_>>();
    let mut rho = squared_norm(&residual);
    let mut outer_residual = rho;
    let mut old_outer_residual = outer_residual;
    let mut stagnant_iterations = 0_usize;
    let mut y = vec![1.0; size];
    let mut next_y = vec![0.0; size];
    let mut z = vec![0.0; size];
    let mut direction = vec![0.0; size];
    let mut scaled_direction = vec![0.0; size];
    let mut multiplied = vec![0.0; size];
    let mut hessian_direction = vec![0.0; size];

    for _ in 0..KR_MAX_OUTER_ITERATIONS {
        if outer_residual <= residual_target {
            return Ok(x);
        }
        ensure_not_cancelled(should_cancel)?;

        y.fill(1.0);
        next_y.fill(0.0);
        z.fill(0.0);
        direction.fill(0.0);
        let mut previous_rho = rho;
        let inner_tolerance = (eta * eta * outer_residual).max(residual_target);

        for inner_iteration in 0..KR_MAX_INNER_ITERATIONS {
            if rho <= inner_tolerance {
                break;
            }
            if inner_iteration == 0 {
                rho = 0.0;
                for index in 0..size {
                    z[index] = residual[index] / v[index];
                    rho += residual[index] * z[index];
                }
                direction.clone_from(&z);
            } else {
                if !previous_rho.is_finite() || previous_rho <= NUMERIC_EPSILON {
                    return Err(normalization_error(
                        "KR conjugate-gradient residual vanished",
                    ));
                }
                let beta = rho / previous_rho;
                for index in 0..size {
                    direction[index] = z[index] + beta * direction[index];
                }
            }

            for index in 0..size {
                scaled_direction[index] = x[index] * direction[index];
            }
            global_matrix.multiply_active_into(
                support,
                &scaled_direction,
                &mut expanded_vector,
                &mut multiplied,
                should_cancel,
            )?;
            matrix_vector_products += 1;
            if matrix_vector_products > matrix_vector_product_limit {
                return Err(normalization_error(
                    "KR did not converge within the matrix-vector product limit",
                ));
            }

            let mut denominator = 0.0;
            for index in 0..size {
                hessian_direction[index] =
                    x[index] * multiplied[index] + v[index] * direction[index];
                denominator += direction[index] * hessian_direction[index];
            }
            if !denominator.is_finite() || denominator <= NUMERIC_EPSILON {
                return Err(normalization_error(
                    "KR encountered a non-positive Newton denominator",
                ));
            }
            let alpha = rho / denominator;
            if !alpha.is_finite() || alpha <= 0.0 {
                return Err(normalization_error("KR produced an invalid Newton step"));
            }

            let mut minimum_y = f64::INFINITY;
            for index in 0..size {
                next_y[index] = y[index] + alpha * direction[index];
                minimum_y = minimum_y.min(next_y[index]);
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
                for index in 0..size {
                    y[index] += boundary_step * alpha * direction[index];
                }
                break;
            }

            std::mem::swap(&mut y, &mut next_y);
            previous_rho = rho;
            rho = 0.0;
            for index in 0..size {
                residual[index] -= alpha * hessian_direction[index];
                z[index] = residual[index] / v[index];
                rho += residual[index] * z[index];
            }
            if !rho.is_finite() || rho < 0.0 {
                return Err(normalization_error("KR residual became non-finite"));
            }
        }

        for index in 0..size {
            x[index] *= y[index];
            if !x[index].is_finite() || x[index] <= 0.0 {
                return Err(normalization_error("KR produced a non-positive weight"));
            }
        }
        global_matrix.multiply_active_into(
            support,
            &x,
            &mut expanded_vector,
            &mut v,
            should_cancel,
        )?;
        matrix_vector_products += 1;
        for index in 0..size {
            v[index] *= x[index];
            if !v[index].is_finite() || v[index] <= NUMERIC_EPSILON {
                return Err(normalization_error("KR produced an invalid marginal"));
            }
            residual[index] = 1.0 - v[index];
        }
        rho = squared_norm(&residual);
        if !rho.is_finite() {
            return Err(normalization_error("KR residual became non-finite"));
        }
        if (rho - outer_residual).abs() <= 1e-12 * outer_residual.max(1.0) {
            stagnant_iterations += 1;
        } else {
            stagnant_iterations = 0;
        }
        if stagnant_iterations >= 20 {
            return Err(normalization_error(
                "KR stopped improving before convergence",
            ));
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

    if outer_residual <= residual_target {
        Ok(x)
    } else {
        Err(normalization_error(
            "KR did not converge within the outer iteration limit",
        ))
    }
}

fn rescale_weights_to_preserve_total(
    matrix: &SparseContactMatrix,
    weights: &mut [f64],
    should_cancel: &dyn Fn() -> bool,
) -> CStudioResult<()> {
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
) -> CStudioResult<Vec<bool>> {
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

fn ensure_not_cancelled(should_cancel: &dyn Fn() -> bool) -> CStudioResult<()> {
    if should_cancel() {
        Err(CStudioError::RequestCancelled)
    } else {
        Ok(())
    }
}

fn normalization_error(message: impl Into<String>) -> CStudioError {
    CStudioError::InvalidContactMapQuery(format!("normalization error: {}", message.into()))
}

#[cfg(test)]
mod tests {
    use super::{
        compute_normalization_weights, ActiveKrSupport, ContactNormalization, GlobalKrMatrix,
        SparseContactMatrix,
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
        matrix
            .bin1
            .iter()
            .zip(matrix.bin2.iter())
            .zip(matrix.counts.iter())
            .map(|((first, second), count)| {
                let symmetry = if first == second { 1.0 } else { 2.0 };
                symmetry * count * weights[*first as usize] * weights[*second as usize]
            })
            .sum()
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
            compute_normalization_weights(&test_matrix(), ContactNormalization::Raw, &|| false,)
                .expect("raw weights"),
            vec![1.0, 1.0, 1.0],
        );
    }

    #[test]
    fn global_kr_csr_active_mask_matches_the_symmetric_sparse_product() {
        let matrix = test_matrix();
        let support = ActiveKrSupport {
            active: vec![1, 0, 1],
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
            .multiply_active_into(&support, &vector, &mut expanded, &mut observed, &|| false)
            .expect("masked global product");

        // Active rows 0 and 2 retain [[4, 2], [2, 5]].
        assert_eq!(observed, vec![14.0, 19.0]);
    }

    #[test]
    fn global_kr_csr_observes_cancellation() {
        let matrix = test_matrix();
        assert!(matches!(
            GlobalKrMatrix::from_sparse(&matrix, &|| true),
            Err(crate::CStudioError::RequestCancelled)
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
            .active_support(&coverage, 10.0, &|| false)
            .expect("active support");

        // Bin 2 exceeds the threshold in the original matrix, but every one of
        // its neighbors is filtered out. It must not become a zero row in BNEWT.
        assert_eq!(support.active_bins, vec![0, 1]);
        assert_eq!(support.active, vec![1, 1, 0, 0, 0, 0]);
    }

    #[test]
    fn vc_and_vc_sqrt_preserve_the_valid_matrix_total() {
        let matrix = test_matrix();
        let raw_total = symmetric_total(&matrix, &[1.0, 1.0, 1.0]);
        for normalization in [ContactNormalization::Vc, ContactNormalization::VcSqrt] {
            let weights = compute_normalization_weights(&matrix, normalization, &|| false)
                .expect("coverage normalization");
            assert!((symmetric_total(&matrix, &weights) - raw_total).abs() < 1e-9);
        }
    }

    #[test]
    fn ice_and_kr_balance_marginals_and_preserve_total() {
        let matrix = test_matrix();
        let raw_total = symmetric_total(&matrix, &[1.0, 1.0, 1.0]);
        for normalization in [ContactNormalization::Ice, ContactNormalization::Kr] {
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

        let error = compute_normalization_weights(&matrix, ContactNormalization::Ice, &|| false)
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

        let weights = compute_normalization_weights(&matrix, ContactNormalization::Kr, &|| false)
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
            ContactNormalization::Ice,
            ContactNormalization::Kr,
            ContactNormalization::Vc,
            ContactNormalization::VcSqrt,
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
        let error =
            compute_normalization_weights(&test_matrix(), ContactNormalization::Kr, &|| true)
                .expect_err("cancelled normalization");
        assert_eq!(error, crate::CStudioError::RequestCancelled);
    }

    #[test]
    fn rejects_pixels_outside_the_bin_table() {
        let error = SparseContactMatrix::new(1, vec![0], vec![1], vec![1.0])
            .expect_err("invalid pixel bin");
        assert!(error.to_string().contains("outside 1 bins"));
    }
}
