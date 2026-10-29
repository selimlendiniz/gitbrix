// GitHub / GitLab accounts in the settings dialog. A token is checked
// with the service when added and then kept in the system keyring; https
// remotes on that host log in with it.

import { useEffect, useState } from "react";

import { Account, api, errorText, Provider } from "../api";

const DEFAULT_URL: Record<Provider, string> = {
  github: "https://github.com",
  gitlab: "https://gitlab.com",
};

const TOKEN_HELP: Record<Provider, string> = {
  github: "GitHub → Settings → Developer settings → Personal access tokens. Classic: scope “repo”. Fine-grained: Contents read & write.",
  gitlab: "GitLab → Preferences → Access tokens. Scopes: read_repository, write_repository (and read_user to show your name).",
};

export function AccountsSection() {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [provider, setProvider] = useState<Provider>("github");
  const [url, setUrl] = useState(DEFAULT_URL.github);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = () =>
    api
      .accounts()
      .then(setAccounts)
      .catch((e) => setError(errorText(e)));

  useEffect(() => {
    void reload();
  }, []);

  function pick(p: Provider) {
    // Keep a self-hosted address the user typed; swap the defaults.
    if (Object.values(DEFAULT_URL).includes(url.trim())) setUrl(DEFAULT_URL[p]);
    setProvider(p);
  }

  async function add() {
    setBusy(true);
    setError(null);
    try {
      await api.addAccount(provider, url.trim(), token.trim());
      setToken("");
      setAdding(false);
      await reload();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(a: Account) {
    setError(null);
    try {
      await api.removeAccount(a.id);
      await reload();
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <div className="accounts" data-testid="accounts">
      <div className="accounts-title">Accounts</div>
      {accounts?.length === 0 && !adding && (
        <div className="dim accounts-empty">No accounts. Add one to push and pull over https with an access token.</div>
      )}
      {accounts?.map((a) => (
        <div key={a.id} className="account-row">
          <span className={`provider-badge ${a.provider}`}>{a.provider === "github" ? "GitHub" : "GitLab"}</span>
          <span className="account-who">
            <strong>{a.username}</strong>
            {a.name && <span className="dim"> · {a.name}</span>}
          </span>
          <span className="dim account-url">{a.url.replace(/^https:\/\//, "")}</span>
          <button type="button" className="small-btn" onClick={() => void remove(a)}>
            Remove
          </button>
        </div>
      ))}
      {adding ? (
        <form
          className="account-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (url.trim() && token.trim() && !busy) void add();
          }}
        >
          <span className="segmented">
            {(["github", "gitlab"] as Provider[]).map((p) => (
              <button key={p} type="button" className={provider === p ? "on" : ""} onClick={() => pick(p)}>
                {p === "github" ? "GitHub" : "GitLab"}
              </button>
            ))}
          </span>
          <label className="modal-label">Address {provider === "gitlab" && <span className="dim">(your server if self-hosted)</span>}</label>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={DEFAULT_URL[provider]} disabled={busy} />
          <label className="modal-label">Access token</label>
          <input
            type="password"
            autoFocus
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={provider === "github" ? "ghp_… or github_pat_…" : "glpat-…"}
            disabled={busy}
            autoComplete="off"
          />
          <div className="dim account-help">{TOKEN_HELP[provider]}</div>
          <div className="modal-actions">
            <button type="button" className="small-btn" onClick={() => setAdding(false)} disabled={busy}>
              Cancel
            </button>
            <button type="submit" className="small-btn primary" disabled={!url.trim() || !token.trim() || busy}>
              {busy ? "Checking…" : "Add account"}
            </button>
          </div>
        </form>
      ) : (
        <button type="button" className="small-btn" onClick={() => setAdding(true)}>
          Add account…
        </button>
      )}
      {error && <pre className="modal-error">{error}</pre>}
    </div>
  );
}
