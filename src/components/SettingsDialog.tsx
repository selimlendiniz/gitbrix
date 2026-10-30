import { create } from "zustand";

import { PullMode } from "../api";
import { DEFAULTS, Settings, updateSettings, useSettings } from "../settings";
import { testNotification } from "../prs";
import { AccountsSection } from "./Accounts";
import { ProfilesSection } from "./Profiles";
import { TransferButtons } from "./Transfer";
import { checkForUpdates, updateStatus, useUpdates } from "../updates";

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

function UpdateLine() {
  const { info, checking, error } = useUpdates();
  const text = checking ? "Checking…" : error ?? updateStatus(info);
  return text ? <span className={`settings-note ${error ? "error-text" : "dim"}`}>{text}</span> : null;
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
          <span>Auto-stash</span>
          <Choice
            value={settings.autoStash}
            onChange={(autoStash) => set({ autoStash })}
            options={[
              { value: "ask", label: "Ask when changes are in the way" },
              { value: "always", label: "Always" },
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
          <span>Pull requests</span>
          <Choice
            value={String(settings.prPoll)}
            onChange={(v) => set({ prPoll: Number(v) })}
            options={[
              { value: "0", label: "On open" },
              { value: "1", label: "1 min" },
              { value: "3", label: "3 min" },
              { value: "10", label: "10 min" },
            ]}
          />
          <span>Notifications</span>
          <span className="settings-inline">
            <Choice
              value={settings.prNotify ? "on" : "off"}
              onChange={(v) => set({ prNotify: v === "on" })}
              options={[
                { value: "on", label: "New requests I can approve" },
                { value: "off", label: "Off" },
              ]}
            />
            <button type="button" className="small-btn" title="Show a notification now" onClick={testNotification}>
              Test
            </button>
          </span>
          <span>Comments</span>
          <Choice
            value={settings.commentNotify ? "on" : "off"}
            onChange={(v) => set({ commentNotify: v === "on" })}
            options={[
              { value: "on", label: "Notify about comments on my requests and mentions" },
              { value: "off", label: "Off" },
            ]}
          />
          <span>CI</span>
          <Choice
            value={settings.ciNotify ? "on" : "off"}
            onChange={(v) => set({ ciNotify: v === "on" })}
            options={[
              { value: "on", label: "Notify when my branch's CI finishes" },
              { value: "off", label: "Off" },
            ]}
          />
          <span>Author pictures</span>
          <span className="settings-inline">
            <Choice
              value={settings.gravatar ? "on" : "off"}
              onChange={(v) => set({ gravatar: v === "on" })}
              options={[
                { value: "on", label: "Gravatar" },
                { value: "off", label: "Initials only" },
              ]}
            />
            <span className="dim settings-note">Sends a hash of each author's e-mail address to gravatar.com</span>
          </span>
          <span>Updates</span>
          <span className="settings-inline">
            <input
              className="update-url"
              aria-label="Release address"
              placeholder="https://…/latest.json"
              value={settings.updateUrl}
              onChange={(e) => set({ updateUrl: e.target.value })}
            />
            <label className="checkbox">
              <input type="checkbox" checked={settings.updateCheck} onChange={(e) => set({ updateCheck: e.target.checked })} />
              At start
            </label>
            <button type="button" className="small-btn" disabled={!settings.updateUrl.trim()} onClick={() => void checkForUpdates()}>
              Check now
            </button>
            <UpdateLine />
          </span>
          <span>Settings file</span>
          <TransferButtons />
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
        <AccountsSection />
        <ProfilesSection />
        <div className="modal-actions">
          <button type="button" className="small-btn primary" onClick={close} autoFocus>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
