mod commands;
mod contact_lod_cache;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if let Ok(cache_root) = app.path().app_cache_dir() {
                cstudio_core::cool::configure_persistent_normalization_cache(
                    cache_root.join("normalization-v1"),
                );
            }
            Ok(())
        })
        .manage(commands::ContactCacheState::default())
        .manage(commands::ContactTileCacheState::default())
        .manage(commands::ContactTileRequestState::default())
        .manage(commands::ContactLayoutRegistryState::default())
        .manage(commands::SourceContactCacheState::default())
        .manage(commands::CoverageCacheState::default())
        .manage(commands::SyntenyCacheState::default())
        .invoke_handler(tauri::generate_handler![
            commands::get_app_status,
            commands::layout_gfa_bandage,
            commands::load_example_dataset,
            commands::load_example_gfa_text,
            commands::select_contact_file,
            commands::select_coverage_file,
            commands::select_paf_file,
            commands::select_project_directory,
            commands::save_agp_file,
            commands::overwrite_agp_file,
            commands::set_window_title,
            commands::build_contact_map_view,
            commands::build_contact_map_view_from_cool,
            commands::build_contact_map_overview_from_cool,
            commands::register_contact_map_layout,
            commands::log_contact_tile_frontend_ipc,
            commands::log_contact_pan_frontend_performance,
            commands::log_gfa_frontend_performance,
            commands::begin_contact_tile_generation,
            commands::prewarm_contact_normalizations,
            commands::cancel_contact_normalization_prewarm,
            commands::get_contact_map_tiles_from_cool,
            commands::get_contact_map_tiles_from_cool_binary_v1,
            commands::stream_contact_map_tiles_from_cool_binary_v1,
            commands::stream_contact_map_tile_deltas_from_cool_binary_v1,
            commands::build_coverage_view,
            commands::build_coverage_view_from_bedgraph,
            commands::build_synteny_view,
            commands::build_synteny_view_from_paf
        ])
        .run(tauri::generate_context!())
        .expect("failed to run C-Studio application");
}
