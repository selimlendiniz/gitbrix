// Settings file buttons (Settings dialog) and the window that shows what a
// file holds before taking it in.

import { open as pickFile, save as pickSaveFile } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import { create } from "zustand";

import { api, errorText } from "../api";
import { applyImport, exportText, Exported, parseExport, Part } from "../transfer";
import { useStore } from "../store";

const useImport = create<{ data: Exported | null; name: string }>(() => ({ data: null, name: "" }));

async function exportFile() {
  const toast = useStore.getState().toast;
  try {
    const path = await pickSaveFile({
      title: "Export settings",
      defaultPath: "gitbrix-settings.json",
      filters: [{ name: "gitbrix settings", extensions: ["json"] }],
    });
    if (!path) return;
    await api.saveTextFile(path, await exportText());
    toast("info", `Saved ${path.split("/").pop()} (no tokens in it)`);
  } catch (e) {
    toast("error", errorText(e));
  }
}

async function importFile() {
  const toast = useStore.getState().toast;
  try {
    const path = await pickFile({ title: "Import settings", filters: [{ name: "gitbrix settings", extensions: ["json"] }] });
    if (typeof path !== "string") return;
    useImport.setState({ data: parseExport(await api.readTextFile(path)), name: path.split("/").pop() ?? path });
  } catch (e) {
    toast("error", errorText(e));
  }
}

export function TransferButtons() {
  return (
    <span className="settings-inline">
      <button type="button" className="small-btn" onClick={() => void exportFile()}>
        Export…
      </button>
      <button type="button" className="small-btn" onClick={() => void importFile()}>
        Import…
      </button>
      <span className="dim settings-note">Preferences, workspaces, profiles and accounts; never tokens</span>
    </span>
  );
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

export function ImportDialog() {
  const data = useImport((s) => s.data);
  const name = useImport((s) => s.name);
  const [parts, setParts] = useState<Set<Part>>(new Set(["settings", "workspaces", "profiles", "accounts"]));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!data) return null;
  const close = () => {
    useImport.setState({ data: null });
    setError(null);
  };
  const rows: { part: Part; label: string; detail: string; empty: boolean }[] = [
    {
      part: "settings",
      label: "Preferences",
      detail: "theme, pull mode, fetch and request timers… (replace these)",
      empty: !Object.keys(data.settings).length,
    },
    {
      part: "workspaces",
      label: plural(data.workspaces.length, "workspace"),
      detail: data.workspaces.map((w) => `${w.name} (${w.repos.length})`).join(", "),
      empty: !data.workspaces.length,
    },
    {
      part: "profiles",
      label: plural(data.profiles.length, "profile"),
      detail: data.profiles.map((p) => `${p.name} <${p.userEmail}>`).join(", "),
      empty: !data.profiles.length,
    },
    {
      part: "accounts",
      label: plural(data.accounts.length, "account"),
      detail: `${data.accounts.map((a) => `${a.username} on ${a.url.replace(/^https?:\/\//, "")}`).join(", ")} — each needs its token added here`,
      empty: !data.accounts.length,
    },
  ];
  const chosen = rows.filter((r) => !r.empty && parts.has(r.part));

  async function take() {
    setBusy(true);
    setError(null);
    try {
      const missing = await applyImport(data!, new Set(chosen.map((r) => r.part)));
      useStore
        .getState()
        .toast("info", missing.length ? `Imported. Add tokens for ${plural(missing.length, "account")} in Settings → Accounts` : "Imported");
      close();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div
        className="modal wide"
        role="dialog"
        aria-label="Import settings"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && close()}
      >
        <div className="modal-title">Import settings</div>
        <p className="modal-message">
          From {name}
          {data.exported && `, exported ${new Date(data.exported).toLocaleString()}`}. Workspaces and profiles with the same id are
          replaced, others are added.
        </p>
        <div className="import-parts">
          {rows.map((r) => (
            <label key={r.part} className={`checkbox import-part${r.empty ? " dim" : ""}`}>
              <input
                type="checkbox"
                disabled={r.empty || busy}
                checked={!r.empty && parts.has(r.part)}
                onChange={(e) => {
                  const next = new Set(parts);
                  if (e.target.checked) next.add(r.part);
                  else next.delete(r.part);
                  setParts(next);
                }}
              />
              <span>
                <strong>{r.empty ? `No ${r.part}` : r.label}</strong>
                {!r.empty && r.detail && <span className="dim import-detail">{r.detail}</span>}
              </span>
            </label>
          ))}
        </div>
        {error && <pre className="modal-error">{error}</pre>}
        <div className="modal-actions">
          <button type="button" className="small-btn" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="small-btn primary" onClick={() => void take()} disabled={busy || !chosen.length} autoFocus>
            {busy ? "Importing…" : "Import"}
          </button>
        </div>
      </div>
    </div>
  );
}
