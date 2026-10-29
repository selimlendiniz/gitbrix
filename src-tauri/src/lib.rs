mod commands;
mod error;
mod git;
mod watch;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(watch::WatchState::default())
        .invoke_handler(tauri::generate_handler![
            commands::initial_repo,
            commands::open_repo,
            commands::watch_repo,
            commands::unwatch_repo,
            commands::repo_info,
            commands::get_graph,
            commands::get_status,
            commands::get_stashes,
            commands::commit_details,
            commands::commit_file_diff,
            commands::workdir_file_diff,
            commands::head_message,
            commands::file_history,
            commands::blame,
            commands::stage,
            commands::stage_all,
            commands::unstage,
            commands::unstage_all,
            commands::discard,
            commands::apply_patch,
            commands::conflict_file,
            commands::resolve_conflict,
            commands::commit,
            commands::checkout_branch,
            commands::checkout_remote,
            commands::checkout_detached,
            commands::create_branch,
            commands::delete_branch,
            commands::rename_branch,
            commands::delete_remote_branch,
            commands::create_tag,
            commands::delete_tag,
            commands::fetch,
            commands::pull,
            commands::push,
            commands::clone_repo,
            commands::init_repo,
            commands::stash_save,
            commands::stash_apply,
            commands::stash_drop,
            commands::stash_store,
            commands::cherry_pick,
            commands::revert,
            commands::reset,
            commands::merge,
            commands::rebase,
            commands::sequencer,
            commands::rebase_commits,
            commands::interactive_rebase,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
