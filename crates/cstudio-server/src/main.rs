use clap::Parser;
use cstudio_server::{serve, ServerConfig};
use std::{net::SocketAddr, path::PathBuf};

#[derive(Debug, Parser)]
#[command(
    name = "cstudio-server",
    about = "Serve read-only .cool/.mcool metadata and contact-map tiles over HTTP"
)]
struct Cli {
    /// Address to listen on. Loopback is the safe default.
    #[arg(long, default_value = "127.0.0.1:8787")]
    bind: SocketAddr,

    /// Dataset mapping in the form ID=/absolute/path/to/data.mcool. Repeat as needed.
    #[arg(long, value_name = "ID=PATH", required = true)]
    dataset: Vec<String>,

    /// File containing the bearer token accepted in the Authorization header.
    #[arg(long, value_name = "PATH")]
    token_file: Option<PathBuf>,

    /// Explicitly allow a non-loopback listener without authentication.
    #[arg(long)]
    allow_unauthenticated_remote: bool,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "cstudio_server=info,tower_http=info".into()),
        )
        .init();

    let cli = Cli::parse();
    serve(ServerConfig {
        bind: cli.bind,
        dataset_specs: cli.dataset,
        token_file: cli.token_file,
        allow_unauthenticated_remote: cli.allow_unauthenticated_remote,
    })
    .await
}
