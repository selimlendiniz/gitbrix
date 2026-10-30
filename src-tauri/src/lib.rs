mod accounts;
mod avatars;
mod commands;
mod error;
mod forge;
mod git;
mod host;
mod profiles;
mod terminal;
mod updates;
mod watch;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(watch::WatchState::default())
        .manage(terminal::Terminals::default())
        .setup(|app| {
            use tauri::Manager;
            if let Ok(dir) = app.path().app_config_dir() {
                accounts::init(dir.clone());
                profiles::init(dir);
            }
            if let Ok(dir) = app.path().app_cache_dir() {
                avatars::init(dir.join("avatars"));
            }
            Ok(())
        })
        // A closed window's watcher and shells go with it.
        .on_window_event(|window, event| {
            use tauri::Manager;
            if let tauri::WindowEvent::Destroyed = event {
                watch::unwatch(&window.state::<watch::WatchState>(), window.label());
                terminal::close_window(&window.state::<terminal::Terminals>(), window.label());
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::initial_repo,
            commands::open_repo,
            commands::watch_repo,
            commands::unwatch_repo,
            commands::quit_app,
            commands::update_check,
            commands::update_install,
            commands::repo_info,
            commands::get_graph,
            commands::get_status,
            commands::get_stashes,
            commands::commit_details,
            commands::commit_file_diff,
            commands::workdir_file_diff,
            commands::file_base64,
            commands::compare_commits,
            commands::compare_file_diff,
            commands::head_message,
            commands::file_history,
            commands::blame,
            commands::reflog,
            commands::search_history,
            commands::stage,
            commands::stage_all,
            commands::unstage,
            commands::unstage_all,
            commands::discard,
            commands::ignore,
            commands::apply_patch,
            commands::conflict_file,
            commands::resolve_conflict,
            commands::commit,
            commands::reword_head,
            commands::checkout_branch,
            commands::checkout_remote,
            commands::checkout_detached,
            commands::create_branch,
            commands::delete_branch,
            commands::rename_branch,
            commands::move_branch,
            commands::delete_remote_branch,
            commands::create_tag,
            commands::delete_tag,
            commands::fetch,
            commands::pull,
            commands::push,
            commands::clone_repo,
            commands::get_worktrees,
            commands::get_submodules,
            commands::submodule_update,
            commands::add_worktree,
            commands::remove_worktree,
            commands::prune_worktrees,
            commands::worktree_ignored,
            commands::get_remotes,
            commands::add_remote,
            commands::remove_remote,
            commands::rename_remote,
            commands::set_remote_url,
            commands::fetch_remote,
            commands::push_branch,
            commands::set_upstream,
            commands::push_tag,
            commands::init_repo,
            commands::stash_save,
            commands::stash_paths,
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
            commands::get_accounts,
            commands::add_account,
            commands::remove_account,
            commands::pull_requests,
            commands::pull_request_inbox,
            commands::issues,
            commands::overlaps,
            commands::approve_pull_request,
            commands::pull_request_conversation_for,
            commands::checkout_pull_request,
            commands::repo_summaries,
            commands::find_repos,
            commands::get_profiles,
            commands::save_profiles,
            commands::identity,
            commands::terminal_open,
            commands::terminal_write,
            commands::terminal_resize,
            commands::terminal_close,
            commands::pull_request_form,
            commands::create_pull_request,
            commands::pull_request_range,
            commands::pull_request_conversation,
            commands::comment_pull_request,
            commands::merge_pull_request,
            commands::reply_pull_request,
            commands::pull_request_details,
            commands::project_labels,
            commands::edit_pull_request,
            commands::set_pull_request_open,
            commands::review_pull_request,
            commands::apply_suggestion,
            commands::resolve_pull_request_thread,
            commands::ci_statuses,
            commands::ci_jobs,
            commands::ci_log,
            commands::ci_retry,
            commands::lfs_pending,
            commands::lfs_pull,
            commands::lfs_track,
            commands::format_patch,
            commands::save_text_file,
            commands::read_text_file,
            commands::apply_patch_file,
            commands::read_patch_file,
            commands::cherry_pick_many,
            commands::revert_many,
            commands::stale_branches,
            commands::bisect_status,
            commands::bisect_start,
            commands::bisect_mark,
            commands::bisect_reset,
            commands::bisect_run,
            commands::comment_pull_request_line,
            commands::release_notes,
            commands::create_release,
            commands::tree_at,
            commands::list_files,
            commands::file_at,
            commands::repo_stats,
            commands::avatars,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
