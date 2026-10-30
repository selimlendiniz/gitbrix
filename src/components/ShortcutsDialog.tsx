import { create } from "zustand";

export const useShortcuts = create<{ open: boolean }>(() => ({ open: false }));

const SHORTCUTS: [string, string][] = [
  ["Ctrl+K, Ctrl+Shift+P", "Command palette"],
  ["Ctrl+F", "Search commits"],
  ["Ctrl+`", "Show or hide the terminal"],
  ["Enter / Shift+Enter", "Next / previous search match"],
  ["↑ ↓ Home End", "Move through commits (graph focused)"],
  ["Ctrl/Shift+click", "Compare two commits"],
  ["Ctrl+Z", "Undo last action"],
  ["Ctrl+Enter", "Commit (in the message box)"],
  ["↑ ↓, Space", "File lists: move, stage / unstage"],
  ["Double-click", "File: stage / unstage · Commit with branch: check out"],
  ["Click, Shift+click", "Select diff lines to stage"],
  ["F5, Ctrl+R", "Refresh"],
  ["Ctrl+O", "Open repository"],
  ["Esc", "Close diff, dialog or menu"],
  ["p r s f d, Alt+↑↓", "Interactive rebase: action, move"],
  ["?", "This list"],
];

export function ShortcutsDialog() {
  const open = useShortcuts((s) => s.open);
  if (!open) return null;
  const close = () => useShortcuts.setState({ open: false });
  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div className="modal wide" role="dialog" aria-label="Keyboard shortcuts" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && close()}>
        <div className="modal-title">Keyboard shortcuts</div>
        <div className="settings-grid shortcuts">
          {SHORTCUTS.map(([k, what]) => (
            <div key={k} style={{ display: "contents" }}>
              <kbd>{k}</kbd>
              <span>{what}</span>
            </div>
          ))}
        </div>
        <div className="modal-actions">
          <button className="small-btn primary" onClick={close} autoFocus>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
