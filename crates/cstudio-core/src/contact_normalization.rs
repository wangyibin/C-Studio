use crate::{CStudioError, CStudioResult};

const NUMERIC_EPSILON: f64 = 1e-15;
const ICE_TOLERANCE: f64 = 1e-5;
const ICE_MAX_ITERATIONS: usize = 200;
const ICE_MIN_NONZERO_CONTACTS: usize = 10;
const ICE_MAD_MAX: f64 = 5.0;
const KR_TOLERANCE: f64 = 1e-6;
const KR_MAX_OUTER_ITERATIONS: usize = 100;
const KR_MAX_INNER_ITERATIONS: usize = 200;
const KR_MAX_MATRIX_VECTOR_PRODUCTS: usize = 500;
const KR_MAX_RETRY_MATRIX_VECTOR_PRODUCTS: usize = 64;
const KR_RETRY_PERCENTILES: [f64; 6] = [0.0, 1.0, 2.0, 3.0, 4.0, 10.0];

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

    fn multiply_compact(
        &self,
        offsets: &[i32],
        vector: &[f64],
        should_cancel: &dyn Fn() -> bool,
    ) -> CStudioResult<Vec<f64>> {
        let mut product = vec![0.0; vector.len()];
        self.for_each_positive_pixel(should_cancel, |first, second, count| {
            let first_offset = offsets[first];
            let second_offset = offsets[second];
            if first_offset < 0 || second_offset < 0 {
                return;
            }
            let first_offset = first_offset as usize;
            let second_offset = second_offset as usize;
            product[first_offset] += count * vector[second_offset];
            if first_offset != second_offset {
                product[second_offset] += count * vector[first_offset];
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

    let mut last_error = None;
    let mut previous_active_count = None;
    for (retry_index, percentile) in KR_RETRY_PERCENTILES.into_iter().enumerate() {
        ensure_not_cancelled(should_cancel)?;
        let coverage_threshold = positive_coverage_percentile(&coverage, percentile);
        let active_count = coverage
            .iter()
            .filter(|value| value.is_finite() && **value > coverage_threshold)
            .count();
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
        match knight_ruiz_weights_with_threshold(
            matrix,
            &coverage,
            coverage_threshold,
            matrix_vector_product_limit,
            should_cancel,
        ) {
            Ok(weights) => return Ok(weights),
            Err(CStudioError::RequestCancelled) => return Err(CStudioError::RequestCancelled),
            Err(error) => last_error = Some(error),
        }
    }

    Err(last_error.unwrap_or_else(|| normalization_error("KR could not select any active bins")))
}

fn knight_ruiz_weights_with_threshold(
    matrix: &SparseContactMatrix,
    coverage: &[f64],
    coverage_threshold: f64,
    matrix_vector_product_limit: usize,
    should_cancel: &dyn Fn() -> bool,
) -> CStudioResult<Vec<f64>> {
    let mut offsets = vec![-1_i32; matrix.bin_count];
    let mut active_bins = Vec::new();
    for (bin, value) in coverage.iter().enumerate() {
        if value.is_finite() && *value > coverage_threshold {
            if active_bins.len() >= i32::MAX as usize {
                return Err(normalization_error(
                    "KR active-bin index exceeds the supported range",
                ));
            }
            offsets[bin] = active_bins.len() as i32;
            active_bins.push(bin);
        }
    }
    if active_bins.is_empty() {
        return Err(normalization_error("KR could not select any active bins"));
    }

    let mean_coverage =
        active_bins.iter().map(|bin| coverage[*bin]).sum::<f64>() / active_bins.len() as f64;
    let initial = if mean_coverage.is_finite() && mean_coverage > 0.0 {
        1.0 / mean_coverage.sqrt()
    } else {
        1.0
    };
    let compact = knight_ruiz_bnewt(
        matrix,
        &offsets,
        vec![initial; active_bins.len()],
        matrix_vector_product_limit,
        should_cancel,
    )?;
    let mut weights = vec![f64::NAN; matrix.bin_count];
    for (compact_index, bin) in active_bins.into_iter().enumerate() {
        let value = compact[compact_index];
        if value.is_finite() && value > 0.0 {
            weights[bin] = value;
        }
    }
    rescale_weights_to_preserve_total(matrix, &mut weights, should_cancel)?;
    Ok(weights)
}

fn knight_ruiz_bnewt(
    matrix: &SparseContactMatrix,
    offsets: &[i32],
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

    let mut v = matrix.multiply_compact(offsets, &x, should_cancel)?;
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

    for _ in 0..KR_MAX_OUTER_ITERATIONS {
        if outer_residual <= residual_target {
            return Ok(x);
        }
        ensure_not_cancelled(should_cancel)?;

        let mut y = vec![1.0; size];
        let mut z = vec![0.0; size];
        let mut direction = vec![0.0; size];
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

            let scaled_direction = (0..size)
                .map(|index| x[index] * direction[index])
                .collect::<Vec<_>>();
            let multiplied = matrix.multiply_compact(offsets, &scaled_direction, should_cancel)?;
            matrix_vector_products += 1;
            if matrix_vector_products > matrix_vector_product_limit {
                return Err(normalization_error(
                    "KR did not converge within the matrix-vector product limit",
                ));
            }

            let mut hessian_direction = vec![0.0; size];
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

            let mut next_y = vec![0.0; size];
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

            y = next_y;
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
        v = matrix.multiply_compact(offsets, &x, should_cancel)?;
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
    use super::{compute_normalization_weights, ContactNormalization, SparseContactMatrix};

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
