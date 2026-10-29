import { create } from "zustand";

import { PullMode } from "../api";
import { DEFAULTS, Settings, updateSettings, useSettings } from "../settings";

export const useSettingsDialog = create<{ open: boolean }>(() => ({ open: false }));

function Choice<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <span className="segmented">
      {options.map((o) => (
        <button key={o.value} type="button" className={value === o.value ? "on" : ""} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </span>
  );
}

export function SettingsDialog() {
  const open = useSettingsDialog((s) => s.open);
  const settings = useSettings();
  if (!open) return null;
  const close = () => useSettingsDialog.setState({ open: false });
  const set = (patch: Partial<Settings>) => updateSettings(patch);

  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div
        className="modal wide"
        role="dialog"
        aria-label="Settings"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && close()}
      >
        <div className="modal-title">Settings</div>
        <div className="settings-grid">
          <span>Theme</span>
          <Choice
            value={settings.theme}
            onChange={(theme) => set({ theme })}
            options={[
              { value: "dark", label: "Dark" },
              { value: "light", label: "Light" },
              { value: "system", label: "System" },
            ]}
          />
          <span>Pull button</span>
          <Choice<PullMode>
            value={settings.pullMode}
            onChange={(pullMode) => set({ pullMode })}
            options={[
              { value: "ff-only", label: "Fast-forward only" },
              { value: "rebase", label: "Rebase" },
              { value: "merge", label: "Merge" },
            ]}
          />
          <span>Dates</span>
          <Choice
            value={settings.dateFormat}
            onChange={(dateFormat) => set({ dateFormat })}
            options={[
              { value: "relative", label: "3 days ago" },
              { value: "absolute", label: "Oct 26, 14:05" },
            ]}
          />
          <span>File lists</span>
          <Choice
            value={settings.fileView}
            onChange={(fileView) => set({ fileView })}
            options={[
              { value: "list", label: "Paths" },
              { value: "tree", label: "Tree" },
            ]}
          />
          <span>Auto-fetch</span>
          <Choice
            value={String(settings.autoFetch)}
            onChange={(v) => set({ autoFetch: Number(v) })}
            options={[
              { value: "0", label: "Off" },
              { value: "5", label: "5 min" },
              { value: "10", label: "10 min" },
              { value: "30", label: "30 min" },
            ]}
          />
          <span>Panels</span>
          <span>
            <button
              type="button"
              className="small-btn"
              onClick={() => set({ sidebarWidth: DEFAULTS.sidebarWidth, detailsWidth: DEFAULTS.detailsWidth })}
            >
              Reset panel widths
            </button>
          </span>
        </div>
        <div className="modal-actions">
          <button type="button" className="small-btn primary" onClick={close} autoFocus>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
