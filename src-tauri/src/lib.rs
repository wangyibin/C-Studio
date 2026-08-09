mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(commands::ContactCacheState::default())
        .manage(commands::ContactTileCacheState::default())
        .manage(commands::SourceContactCacheState::default())
        .manage(commands::CoverageCacheState::default())
        .manage(commands::SyntenyCacheState::default())
        .invoke_handler(tauri::generate_handler![
            commands::get_app_status,
            commands::load_example_dataset,
            commands::select_contact_file,
            commands::select_coverage_file,
            commands::select_paf_file,
            commands::save_agp_file,
            commands::build_contact_map_view,
            commands::build_contact_map_view_from_cool,
            commands::get_contact_map_tiles_from_cool,
            commands::build_coverage_view,
            commands::build_coverage_view_from_bedgraph,
            commands::build_synteny_view,
            commands::build_synteny_view_from_paf
        ])
        .run(tauri::generate_context!())
        .expect("failed to run C-Studio application");
}
