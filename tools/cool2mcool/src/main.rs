use std::{path::PathBuf, process::ExitCode};

use clap::{Parser, ValueEnum};
use cool2mcool::mcool::{generate, GenerationOptions, Progress, BASE_RESOLUTION};
use cool2mcool::zoomify::{AggregationMode, DEFAULT_COMPRESSION_LEVEL, MAX_COMPRESSION_LEVEL};

/// The CLI presents default resolutions from coarse to fine as one copyable
/// comma-separated argument. Generation canonicalizes them to increasing order.
const DEFAULT_RESOLUTION_ARGUMENT: &str =
    "2500000,1000000,500000,250000,100000,50000,25000,10000,5000,1000";
const DEFAULT_KR_MIN_RESOLUTION: u64 = 5_000;

#[derive(Debug, Clone, Copy, ValueEnum)]
enum CliAggregationMode {
    Pyramid,
    Direct,
}

impl From<CliAggregationMode> for AggregationMode {
    fn from(value: CliAggregationMode) -> Self {
        match value {
            CliAggregationMode::Pyramid => Self::Pyramid,
            CliAggregationMode::Direct => Self::Direct,
        }
    }
}

#[derive(Debug, Parser)]
#[command(
    name = "cool2mcool",
    version,
    arg_required_else_help = true,
    about = "Generate a normalized multi-resolution Cooler from a fixed 1 kb COOL file with the native Rust pipeline."
)]
struct Cli {
    /// Input fixed-resolution COOL file at 1 kb.
    #[arg(value_name = "INPUT.cool")]
    input: PathBuf,

    /// Destination MCOOL file.
    #[arg(value_name = "OUTPUT.mcool")]
    output: PathBuf,

    /// Rust aggregation worker count (default: available cores, capped at 8).
    #[arg(
        long,
        value_name = "N",
        default_value_t = default_threads(),
        value_parser = parse_positive_usize
    )]
    threads: usize,

    /// Concurrent resolution levels (at most --threads; default: 2).
    #[arg(
        long,
        value_name = "N",
        default_value_t = 2,
        value_parser = parse_level_parallelism
    )]
    level_parallelism: usize,

    /// Resolution aggregation strategy: reuse parent levels, or aggregate every level from 1 kb.
    #[arg(long, value_enum, default_value_t = CliAggregationMode::Pyramid)]
    aggregation_mode: CliAggregationMode,

    /// Gzip compression level for generated datasets (1-9; lower is faster, higher may reduce size).
    #[arg(
        long,
        value_name = "LEVEL",
        default_value_t = DEFAULT_COMPRESSION_LEVEL,
        value_parser = parse_compression_level
    )]
    compression_level: u8,

    /// Comma-separated resolutions in base pairs; order is canonicalized before generation.
    #[arg(
        long,
        value_name = "BP[,BP...]",
        value_delimiter = ',',
        default_value = DEFAULT_RESOLUTION_ARGUMENT
    )]
    resolutions: Vec<u64>,

    /// Compute and store KR only at resolutions greater than or equal to this value.
    #[arg(
        long,
        value_name = "BP",
        default_value_t = DEFAULT_KR_MIN_RESOLUTION,
        value_parser = parse_kr_min_resolution
    )]
    kr_min_resolution: u64,

    /// Atomically replace an existing output after successful generation.
    #[arg(long)]
    force: bool,
}

impl Cli {
    fn into_arguments(self) -> std::result::Result<Arguments, String> {
        let mut resolutions = self.resolutions;
        if resolutions.is_empty() {
            return Err("--resolutions cannot be empty".to_string());
        }
        if resolutions.contains(&0) {
            return Err("--resolutions values must be greater than zero".to_string());
        }
        resolutions.sort_unstable();
        if resolutions.windows(2).any(|pair| pair[0] == pair[1]) {
            return Err("--resolutions cannot contain duplicate values".to_string());
        }

        Ok(Arguments {
            input: self.input,
            output: self.output,
            options: GenerationOptions {
                resolutions,
                threads: self.threads,
                level_parallelism: self.level_parallelism,
                aggregation_mode: self.aggregation_mode.into(),
                compression_level: self.compression_level,
                kr_min_resolution: self.kr_min_resolution,
                force: self.force,
            },
        })
    }
}

#[derive(Debug)]
struct Arguments {
    input: PathBuf,
    output: PathBuf,
    options: GenerationOptions,
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    match run(cli) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("error: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run(cli: Cli) -> std::result::Result<(), String> {
    let arguments = cli.into_arguments()?;
    let report = generate(
        &arguments.input,
        &arguments.output,
        &arguments.options,
        |event| match event {
            Progress::ValidatingInput => {
                eprintln!("[cool2mcool] validating fixed symmetric-upper 1 kb input");
            }
            Progress::Zoomifying {
                resolutions,
                aggregation_mode,
            } => eprintln!(
                "[cool2mcool] running native Rust {} zoomify with gzip level {}, {} workers and {} level lane(s) for {} levels: {}",
                aggregation_mode.as_str(),
                arguments.options.compression_level,
                arguments.options.threads,
                arguments.options.level_parallelism,
                resolutions.len(),
                join_resolutions(&resolutions)
            ),
            Progress::Normalizing {
                resolution,
                normalization,
            } => {
                eprintln!(
                    "[cool2mcool] {resolution} bp: computing {}",
                    normalization.as_str()
                );
            }
            Progress::NormalizationFallback {
                resolution,
                normalization,
                reason,
            } => {
                eprintln!(
                    "[cool2mcool] {resolution} bp: {} did not converge ({reason}); storing the annotated final iterate",
                    normalization.as_str()
                );
            }
            Progress::Finalizing => {
                eprintln!("[cool2mcool] flushing and atomically installing output");
            }
            Progress::Complete => {}
        },
    )
    .map_err(|error| error.to_string())?;

    eprintln!(
        "[cool2mcool] wrote {} levels with available columns {}; KR stored at {} of {} levels (minimum {} bp) to {}",
        report.resolutions.len(),
        report.normalization_columns.join(","),
        report.kr_resolutions.len(),
        report.resolutions.len(),
        report.kr_min_resolution,
        report.output.display()
    );
    Ok(())
}

fn default_threads() -> usize {
    std::thread::available_parallelism()
        .map_or(1, usize::from)
        .clamp(1, 8)
}

fn parse_positive_usize(value: &str) -> std::result::Result<usize, String> {
    let threads = value
        .parse::<usize>()
        .map_err(|error| format!("expected a positive integer, got {value:?}: {error}"))?;
    if threads == 0 {
        return Err("expected a positive integer greater than zero".to_string());
    }
    Ok(threads)
}

fn parse_level_parallelism(value: &str) -> std::result::Result<usize, String> {
    parse_positive_usize(value)
}

fn parse_compression_level(value: &str) -> std::result::Result<u8, String> {
    let level = value
        .parse::<u8>()
        .map_err(|error| format!("expected a gzip level from 1 to 9, got {value:?}: {error}"))?;
    if (1..=MAX_COMPRESSION_LEVEL).contains(&level) {
        Ok(level)
    } else {
        Err(format!(
            "--compression-level must be between 1 and {MAX_COMPRESSION_LEVEL}"
        ))
    }
}

fn parse_kr_min_resolution(value: &str) -> std::result::Result<u64, String> {
    let resolution = value.parse::<u64>().map_err(|error| {
        format!("expected a positive base-pair resolution, got {value:?}: {error}")
    })?;
    if resolution == 0 || resolution % BASE_RESOLUTION != 0 {
        return Err(format!(
            "--kr-min-resolution must be a positive multiple of {BASE_RESOLUTION} bp"
        ));
    }
    Ok(resolution)
}

fn join_resolutions(resolutions: &[u64]) -> String {
    resolutions
        .iter()
        .map(u64::to_string)
        .collect::<Vec<_>>()
        .join(",")
}

#[cfg(test)]
mod tests {
    use clap::{error::ErrorKind, CommandFactory, Parser};

    use super::{
        default_threads, parse_compression_level, parse_kr_min_resolution, parse_level_parallelism,
        parse_positive_usize, Cli, CliAggregationMode, DEFAULT_COMPRESSION_LEVEL,
        DEFAULT_KR_MIN_RESOLUTION, DEFAULT_RESOLUTION_ARGUMENT,
    };
    use cool2mcool::mcool::DEFAULT_RESOLUTIONS;
    use cool2mcool::zoomify::AggregationMode;

    #[test]
    fn parses_required_paths_and_options() {
        let cli = Cli::try_parse_from([
            "cool2mcool",
            "--force",
            "--threads=3",
            "--level-parallelism=1",
            "--aggregation-mode=direct",
            "--compression-level=6",
            "--resolutions=5000,1000",
            "--kr-min-resolution=5000",
            "input.cool",
            "output.mcool",
        ])
        .expect("valid arguments");
        let arguments = cli.into_arguments().expect("normalized arguments");

        assert!(arguments.options.force);
        assert_eq!(arguments.options.threads, 3);
        assert_eq!(arguments.options.level_parallelism, 1);
        assert_eq!(arguments.options.aggregation_mode, AggregationMode::Direct);
        assert_eq!(arguments.options.compression_level, 6);
        assert_eq!(arguments.options.resolutions, vec![1_000, 5_000]);
        assert_eq!(arguments.options.kr_min_resolution, 5_000);
    }

    #[test]
    fn default_cli_resolutions_match_the_requested_coarse_to_fine_selection() {
        let cli = Cli::try_parse_from(["cool2mcool", "input.cool", "output.mcool"])
            .expect("default arguments");

        assert_eq!(
            cli.resolutions,
            DEFAULT_RESOLUTION_ARGUMENT
                .split(',')
                .map(|value| value.parse::<u64>().expect("valid default"))
                .collect::<Vec<_>>()
        );
        let options = cli
            .into_arguments()
            .expect("canonical default arguments")
            .options;
        assert_eq!(options.resolutions, DEFAULT_RESOLUTIONS);
        assert_eq!(options.compression_level, DEFAULT_COMPRESSION_LEVEL);
        assert_eq!(options.kr_min_resolution, DEFAULT_KR_MIN_RESOLUTION);
    }

    #[test]
    fn help_prints_the_copyable_resolution_default() {
        let help = Cli::command().render_long_help().to_string();
        assert!(help.contains(&format!("[default: {DEFAULT_RESOLUTION_ARGUMENT}]")));
        assert!(help.contains("--kr-min-resolution <BP>"));
        assert!(help.contains(&format!("[default: {DEFAULT_KR_MIN_RESOLUTION}]")));
        assert!(help.contains("--compression-level <LEVEL>"));
        assert!(help.contains(&format!("[default: {DEFAULT_COMPRESSION_LEVEL}]")));
    }

    #[test]
    fn no_arguments_display_help() {
        let error = Cli::try_parse_from(["cool2mcool"]).expect_err("no arguments show help");
        assert_eq!(
            error.kind(),
            ErrorKind::DisplayHelpOnMissingArgumentOrSubcommand
        );
        assert!(error.to_string().contains("Usage: cool2mcool"));
    }

    #[test]
    fn clap_rejects_invalid_option_values() {
        assert!(
            Cli::try_parse_from(["cool2mcool", "--threads=0", "input.cool", "output.mcool",])
                .is_err()
        );
        assert!(Cli::try_parse_from([
            "cool2mcool",
            "--aggregation-mode=not-a-mode",
            "input.cool",
            "output.mcool",
        ])
        .is_err());
        assert!(Cli::try_parse_from(
            ["cool2mcool", "--engine=rust", "input.cool", "output.mcool",]
        )
        .is_err());
        assert!(Cli::try_parse_from([
            "cool2mcool",
            "--cooler-bin=cooler",
            "input.cool",
            "output.mcool",
        ])
        .is_err());
        for invalid in ["0", "1500", "fast"] {
            assert!(Cli::try_parse_from([
                "cool2mcool",
                &format!("--kr-min-resolution={invalid}"),
                "input.cool",
                "output.mcool",
            ])
            .is_err());
        }
        for invalid in ["0", "10", "fast"] {
            assert!(Cli::try_parse_from([
                "cool2mcool",
                &format!("--compression-level={invalid}"),
                "input.cool",
                "output.mcool",
            ])
            .is_err());
        }
    }

    #[test]
    fn rejects_duplicate_resolutions_after_cli_parsing() {
        let cli = Cli::try_parse_from([
            "cool2mcool",
            "--resolutions=1000,1000",
            "input.cool",
            "output.mcool",
        ])
        .expect("syntactically valid arguments");
        assert!(cli.into_arguments().is_err());
    }

    #[test]
    fn validates_numeric_option_helpers() {
        assert_eq!(parse_positive_usize("1").expect("positive"), 1);
        assert!(parse_positive_usize("0").is_err());
        assert_eq!(parse_level_parallelism("1").expect("single lane"), 1);
        assert_eq!(parse_level_parallelism("2").expect("two lanes"), 2);
        assert_eq!(parse_level_parallelism("3").expect("three lanes"), 3);
        assert!(parse_level_parallelism("0").is_err());
        assert!(parse_level_parallelism("many").is_err());
        assert_eq!(parse_compression_level("1").expect("minimum gzip"), 1);
        assert_eq!(parse_compression_level("9").expect("maximum gzip"), 9);
        assert!(parse_compression_level("0").is_err());
        assert!(parse_compression_level("10").is_err());
        assert_eq!(parse_kr_min_resolution("1000").expect("1 kb"), 1_000);
        assert_eq!(parse_kr_min_resolution("5000").expect("5 kb"), 5_000);
        assert!(parse_kr_min_resolution("0").is_err());
        assert!(parse_kr_min_resolution("1500").is_err());
        assert!((1..=8).contains(&default_threads()));
        assert_eq!(
            AggregationMode::from(CliAggregationMode::Pyramid),
            AggregationMode::Pyramid
        );
    }
}
