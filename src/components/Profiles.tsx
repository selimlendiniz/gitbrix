// Profiles in the settings dialog, the toolbar's profile switcher and the
// "committing as" line of the commit form.

import { open as pickFolder } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";

import { Account, api, errorText, Profile } from "../api";
import { loadProfiles, newProfileId, saveProfiles, switchProfile, useProfiles } from "../profiles";
import { useStore } from "../store";
import { useSettingsDialog } from "./SettingsDialog";

const blank = (): Profile => ({ id: newProfileId(), name: "", userName: "", userEmail: "", folders: [], accounts: [] });

function ProfileForm({
  initial,
  accounts,
  onDone,
}: {
  initial: Profile;
  accounts: Account[];
  onDone: () => void;
}) {
  const [p, setP] = useState(initial);
  const [folders, setFolders] = useState(initial.folders.join("\n"));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setError(null);
    const profile = { ...p, folders: folders.split("\n").map((f) => f.trim()).filter(Boolean) };
    const { profiles } = useProfiles.getState();
    const exists = profiles.list.some((x) => x.id === p.id);
    const list = exists ? profiles.list.map((x) => (x.id === p.id ? profile : x)) : [...profiles.list, profile];
    try {
      // The first profile becomes the active one.
      await saveProfiles({ active: profiles.active ?? (profiles.list.length ? null : p.id), list });
      onDone();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function addFolder() {
    try {
      const picked = await pickFolder({ directory: true, multiple: false, title: "Repositories under this folder use the profile" });
      if (typeof picked === "string") setFolders((f) => (f.trim() ? `${f.trim()}\n${picked}` : picked));
    } catch (e) {
      setError(errorText(e));
    }
  }

  const toggleAccount = (id: string, on: boolean) =>
    setP((x) => ({ ...x, accounts: on ? [...x.accounts, id] : x.accounts.filter((a) => a !== id) }));

  return (
    <form
      className="account-form profile-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy) void save();
      }}
    >
      <label className="modal-label">Profile name</label>
      <input autoFocus value={p.name} placeholder="Work" onChange={(e) => setP({ ...p, name: e.target.value })} disabled={busy} />
      <div className="profile-pair">
        <div>
          <label className="modal-label">Commit as (name)</label>
          <input value={p.userName} placeholder="Selim Ardaçevik" onChange={(e) => setP({ ...p, userName: e.target.value })} disabled={busy} />
        </div>
        <div>
          <label className="modal-label">Email</label>
          <input value={p.userEmail} placeholder="selim@company.com" onChange={(e) => setP({ ...p, userEmail: e.target.value })} disabled={busy} />
        </div>
      </div>
      <label className="modal-label">
        Folders <span className="dim">(repositories under them always use this profile; one per line)</span>
      </label>
      <div className="profile-folders">
        <textarea rows={2} value={folders} placeholder="~/work" onChange={(e) => setFolders(e.target.value)} disabled={busy} />
        <button type="button" className="small-btn" onClick={() => void addFolder()} disabled={busy}>
          Add folder…
        </button>
      </div>
      {accounts.length > 0 && (
        <>
          <label className="modal-label">
            Accounts <span className="dim">(none ticked: all of them)</span>
          </label>
          <div className="profile-accounts">
            {accounts.map((a) => (
              <label key={a.id} className="checkbox">
                <input type="checkbox" checked={p.accounts.includes(a.id)} onChange={(e) => toggleAccount(a.id, e.target.checked)} />
                {a.username} <span className="dim">{a.url.replace(/^https:\/\//, "")}</span>
              </label>
            ))}
          </div>
        </>
      )}
      <div className="modal-actions">
        <button type="button" className="small-btn" onClick={onDone} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="small-btn primary" disabled={busy}>
          Save profile
        </button>
      </div>
      {error && <pre className="modal-error">{error}</pre>}
    </form>
  );
}

export function ProfilesSection() {
  const profiles = useProfiles((s) => s.profiles);
  const [editing, setEditing] = useState<Profile | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadProfiles();
    api.accounts().then(setAccounts).catch(() => {});
  }, []);

  async function remove(p: Profile) {
    setError(null);
    try {
      await saveProfiles({
        active: profiles.active === p.id ? null : profiles.active,
        list: profiles.list.filter((x) => x.id !== p.id),
      });
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <div className="accounts" data-testid="profiles">
      <div className="accounts-title">Profiles</div>
      {profiles.list.length === 0 && !editing && (
        <div className="dim accounts-empty">
          No profiles: commits use user.name and user.email from git config. Add one per identity, such as work and personal.
        </div>
      )}
      {profiles.list.length > 0 && (
        <label className="account-row profile-row">
          <input type="radio" name="active-profile" checked={!profiles.active} onChange={() => void switchProfile(null)} />
          <span className="account-who dim">No profile (git config) outside the folders below</span>
        </label>
      )}
      {profiles.list.map((p) => (
        <div key={p.id} className="account-row profile-row">
          <input
            type="radio"
            name="active-profile"
            aria-label={`Use ${p.name}`}
            checked={profiles.active === p.id}
            onChange={() => void switchProfile(p.id)}
          />
          <span className="account-who">
            <strong>{p.name}</strong>
            <span className="dim">
              {" "}
              · {p.userName} &lt;{p.userEmail}&gt;
            </span>
          </span>
          <span className="dim account-url" title={p.folders.join("\n")}>
            {p.folders.length ? p.folders.join(", ") : ""}
          </span>
          <button type="button" className="small-btn" onClick={() => setEditing(p)}>
            Edit
          </button>
          <button type="button" className="small-btn" onClick={() => void remove(p)}>
            Remove
          </button>
        </div>
      ))}
      {editing ? (
        <ProfileForm key={editing.id} initial={editing} accounts={accounts} onDone={() => setEditing(null)} />
      ) : (
        <button type="button" className="small-btn" onClick={() => setEditing(blank())}>
          Add profile…
        </button>
      )}
      {error && <pre className="modal-error">{error}</pre>}
    </div>
  );
}

/** Toolbar chip: the profile the open repository uses; click to switch. */
export function ProfileButton() {
  const profiles = useProfiles((s) => s.profiles);
  const identity = useProfiles((s) => s.identity);
  if (!profiles.list.length) return null;
  const active = profiles.list.find((p) => p.id === profiles.active);
  const label = identity?.source === "profile" ? identity.profile : identity?.source === "repository" ? "repo" : active?.name ?? "—";
  const title = identity
    ? `Committing as ${identity.name ?? "?"} <${identity.email ?? "?"}> (${identity.source === "profile" ? `profile ${identity.profile}` : identity.source})`
    : "Profile";
  return (
    <button
      className="profile-button"
      title={title}
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        useStore.getState().showMenu(r.left - 120, r.bottom + 4, [
          ...profiles.list.map((p) => ({
            label: `${profiles.active === p.id ? "✓ " : ""}${p.name}`,
            hint: p.userEmail,
            onSelect: () => void switchProfile(p.id),
          })),
          { label: `${profiles.active ? "" : "✓ "}No profile`, hint: "git config", onSelect: () => void switchProfile(null) },
          { separator: true, label: "" },
          { label: "Manage profiles…", onSelect: () => useSettingsDialog.setState({ open: true }) },
        ]);
      }}
    >
      <span className="profile-dot" />
      {label}
    </button>
  );
}

/** Under the commit button: whose name goes on the commit. */
export function CommitIdentity() {
  const identity = useProfiles((s) => s.identity);
  if (!identity) return null;
  if (!identity.name || !identity.email) {
    return (
      <div className="commit-identity missing">
        No name or email for commits.{" "}
        <button type="button" className="link-btn" onClick={() => useSettingsDialog.setState({ open: true })}>
          Add a profile
        </button>
      </div>
    );
  }
  const from = identity.source === "profile" ? `profile ${identity.profile}` : identity.source;
  return (
    <div className="commit-identity" title={`From ${from}`}>
      as {identity.name} &lt;{identity.email}&gt; <span className="dim">· {from}</span>
    </div>
  );
}
