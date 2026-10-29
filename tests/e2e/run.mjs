#!/usr/bin/env node
// End-to-end test of the real app: Xvfb + tauri-driver + WebKitWebDriver.
//
//   pnpm tauri build --debug --no-bundle && node tests/e2e/run.mjs
//
// Builds a demo repository, launches the debug binary on it, drives the
// UI over WebDriver, and checks the effects with the git CLI. Screenshots
// land in test-results/shots/e2e-*.png.

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
// E2E_APP=src-tauri/target/release/gitbrix tests the release build instead.
const app = resolve(root, process.env.E2E_APP ?? "src-tauri/target/debug/gitbrix");
const shots = join(root, "test-results/shots");
const DISPLAY = process.env.E2E_DISPLAY ?? ":99";
const PORT = 4444;
const ELEMENT = "element-6066-11e4-a52e-4f735466cecf";

mkdirSync(shots, { recursive: true });
const work = mkdtempSync(join(tmpdir(), "gitbrix-e2e-"));
const demo = join(work, "demo");
execFileSync(join(root, "scripts/demo-repo.sh"), [demo], { stdio: "ignore" });
const repo = join(demo, "demo-app");
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();

const children = [];
function start(cmd, args, env = {}) {
  const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  p.stderr.on("data", (d) => process.env.E2E_VERBOSE && process.stderr.write(`[${cmd}] ${d}`));
  children.push(p);
  return p;
}

function cleanup() {
  for (const p of children.reverse()) p.kill("SIGTERM");
  rmSync(work, { recursive: true, force: true });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function wd(method, path, body) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path}: ${JSON.stringify(json.value ?? json)}`);
  return json.value;
}

async function waitFor(what, fn, timeout = 30000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ""}`);
}

let session;
const find = (css) => wd("POST", `/session/${session}/element`, { using: "css selector", value: css }).then((e) => e[ELEMENT]);
// WebKitWebDriver's "Get Element Text" returns "" for our elements, so
// read textContent through script instead.
const text = (css) => js("const e = document.querySelector(arguments[0]); return e ? e.textContent : null", css);
const click = async (css) => wd("POST", `/session/${session}/element/${await find(css)}/click`, {});
const type = async (css, value) => wd("POST", `/session/${session}/element/${await find(css)}/value`, { text: value });
const js = (script, ...args) => wd("POST", `/session/${session}/execute/sync`, { script, args });
async function shot(name) {
  const png = await wd("GET", `/session/${session}/screenshot`);
  writeFileSync(join(shots, `e2e-${name}.png`), Buffer.from(png, "base64"));
}

const results = [];
async function step(name, fn) {
  try {
    await fn();
    results.push(["ok", name]);
    console.log(`  ✓ ${name}`);
  } catch (e) {
    results.push(["FAIL", name]);
    console.log(`  ✗ ${name}\n    ${e.message}`);
    await shot(`fail-${name.replace(/\W+/g, "-")}`).catch(() => {});
    throw e;
  }
}

try {
  if (!process.env.E2E_DISPLAY) start("Xvfb", [DISPLAY, "-screen", "0", "1440x900x24", "-nolisten", "tcp"]);
  await sleep(500);
  // Resolve through mise now: with XDG_DATA_HOME redirected below, the
  // mise shim could no longer find its installs.
  const driver = execFileSync("mise", ["which", "tauri-driver"], { cwd: root, encoding: "utf8" }).trim();
  start(driver, ["--port", String(PORT)], {
    // Keep the app's webview storage (recent repos, tabs) out of the
    // real user profile.
    XDG_DATA_HOME: join(work, "xdg-data"),
    XDG_CONFIG_HOME: join(work, "xdg-config"),
    XDG_CACHE_HOME: join(work, "xdg-cache"),
    DISPLAY,
    GDK_BACKEND: "x11",
    WAYLAND_DISPLAY: "",
    // No GPU in Xvfb.
    WEBKIT_DISABLE_DMABUF_RENDERER: "1",
    LIBGL_ALWAYS_SOFTWARE: "1",
  });
  await waitFor("tauri-driver", () => fetch(`http://127.0.0.1:${PORT}/status`).then((r) => r.ok));

  const s = await wd("POST", "/session", {
    capabilities: { alwaysMatch: { browserName: "wry", "tauri:options": { application: app, args: [repo] } } },
  });
  session = s.sessionId;
  console.log("e2e: session started");

  await step("opens the repository given on the command line", async () => {
    await waitFor("repo name", async () => (await text(".repo-name")) === "demo-app");
    await waitFor("graph rows", () => js("return document.querySelectorAll('.graph-row').length > 5"));
    await shot("01-open");
  });

  await step("shows commit details for a clicked row", async () => {
    await js(`[...document.querySelectorAll('.graph-row')].find(r => r.textContent.includes('Wire parser into main')).dispatchEvent(new MouseEvent('mousedown', {bubbles: true, button: 0}))`);
    await waitFor("details", async () => (await text(".commit-summary")) === "Wire parser into main");
    await click(".file-row");
    await waitFor("diff", () => js("return !!document.querySelector('.dl.add')"));
    // Syntax colours load as separate chunks: proves the CSP allows them.
    await waitFor("syntax highlighting", () => js("return !!document.querySelector('.diff-table [class*=hl-]')"));
    await shot("02-commit-diff");
  });

  await step("stages a file and commits it", async () => {
    await js(`document.querySelector('.diff-header .icon-btn[title^="Close"]').click()`);
    await js(`document.querySelector('.graph-row.wip').dispatchEvent(new MouseEvent('mousedown', {bubbles: true, button: 0}))`);
    await waitFor("wip panel", () => js("return !!document.querySelector('.wip-panel')"));
    await js(`[...document.querySelectorAll('.file-row')].find(r => r.textContent.includes('notes.txt')).querySelector('[title="Stage file"]').click()`);
    await waitFor("notes.txt staged", () => git("diff", "--cached", "--name-only").includes("notes.txt"));
    await type(".commit-summary-input", "Add notes from e2e");
    await waitFor("commit button", () => js("return !document.querySelector('.commit-form .primary-btn').disabled"));
    await click(".commit-form .primary-btn");
    await waitFor("commit created", () => git("log", "-1", "--format=%s") === "Add notes from e2e");
    await waitFor("graph updated", () =>
      js("return [...document.querySelectorAll('.graph-row')].some(r => r.textContent.includes('Add notes from e2e'))"),
    );
    await shot("03-after-commit");
  });

  await step("creates a branch from the toolbar", async () => {
    await js(`[...document.querySelectorAll('.tool-btn')].find(b => b.textContent.includes('Branch')).click()`);
    await waitFor("dialog", () => js("return !!document.querySelector('.modal input')"));
    await type(".modal input", "e2e/branch");
    await click(".modal button[type=submit]");
    await waitFor("branch exists and is checked out", () => git("branch", "--show-current") === "e2e/branch");
    await waitFor("toolbar shows branch", async () => (await text(".branch-name")).includes("e2e/branch"));
    await shot("04-branch");
  });

  await step("stages a single hunk from the diff view", async () => {
    // src/main.rs has one unstaged hunk in the demo repo.
    await js(`[...document.querySelectorAll('.wip-panel .file-row')].find(r => r.textContent.includes('main.rs')).click()`);
    await waitFor("hunk button", () => js(`return [...document.querySelectorAll('.hunk-actions button')].some(b => b.textContent === 'Stage hunk')`));
    await shot("05-hunk");
    await js(`[...document.querySelectorAll('.hunk-actions button')].find(b => b.textContent === 'Stage hunk').click()`);
    await waitFor("main.rs staged", () => git("diff", "--cached", "--name-only").includes("src/main.rs"));
    if (git("diff", "--name-only").includes("src/main.rs")) throw new Error("main.rs still has unstaged changes");
    await js(`document.querySelector('.diff-header .icon-btn[title^="Close"]')?.click()`);
  });

  await step("picks up changes made outside the app", async () => {
    writeFileSync(join(repo, "external.txt"), "written by another program\n");
    await waitFor("external.txt listed", () =>
      js("return [...document.querySelectorAll('.wip-panel .file-row')].some(r => r.textContent.includes('external.txt'))"),
    );
    git("commit", "-q", "--allow-empty", "-m", "Commit from terminal");
    await waitFor("terminal commit in graph", () =>
      js("return [...document.querySelectorAll('.graph-row')].some(r => r.textContent.includes('Commit from terminal'))"),
    );
    await shot("06-external-change");
  });

  await step("interactive rebase: drop one commit, reword another", async () => {
    // HEAD: "Commit from terminal" <- "Add notes from e2e" <- "Tidy up main"
    git("stash", "-u", "-q"); // the rebase autostashes too, but keep the tree simple
    await waitFor("clean tree", () => js("return !document.querySelector('.graph-row.wip')"));
    await js(`const row = [...document.querySelectorAll('.graph-row')].find(r => r.textContent.includes('Tidy up main'));
              row.dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, clientX: 600, clientY: 300}))`);
    await js(`[...document.querySelectorAll('.menu-item')].find(b => b.textContent.includes('Interactive rebase')).click()`);
    await waitFor("rebase rows", () => js("return document.querySelectorAll('.rebase-row').length === 2"));
    const rowButton = (row, label) =>
      js(`[...document.querySelectorAll('.rebase-row')[${row}].querySelectorAll('.rebase-actions button')].find(b => b.textContent === '${label}').click()`);
    await rowButton(0, "Drop");
    await rowButton(1, "Reword");
    await waitFor("message box", () => js("return !!document.querySelector('.rebase-message')"));
    await js(
      `const t = document.querySelector('.rebase-message');
       Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(t, arguments[0]);
       t.dispatchEvent(new Event('input', {bubbles: true}));`,
      "Notes, reworded by e2e",
    );
    await shot("07-rebase-plan");
    await js(`[...document.querySelectorAll('.diff-header button')].find(b => b.textContent === 'Start rebase').click()`);
    await waitFor("rebased", () => git("log", "-1", "--format=%s") === "Notes, reworded by e2e");
    if (git("log", "-2", "--format=%s").includes("Commit from terminal")) throw new Error("dropped commit still there");
    await waitFor("view closed", () => js("return !document.querySelector('[data-testid=rebase]')"));
    git("stash", "pop", "-q");
  });

  await step("resolves a merge conflict and continues the merge", async () => {
    git("add", "-A");
    git("commit", "-q", "-m", "Save work before conflict");
    writeFileSync(join(repo, "conflict.txt"), "base\n");
    git("add", "conflict.txt");
    git("commit", "-q", "-m", "Add conflict.txt");
    git("switch", "-q", "-c", "side");
    writeFileSync(join(repo, "conflict.txt"), "theirs\n");
    git("commit", "-q", "-am", "Side change");
    git("switch", "-q", "-");
    writeFileSync(join(repo, "conflict.txt"), "ours\n");
    git("commit", "-q", "-am", "Our change");
    try {
      git("merge", "side");
    } catch {
      // expected: conflict
    }
    await waitFor("merge banner", () => js("return !!document.querySelector('.op-banner.conflict')"));
    await js(`document.querySelector('.graph-row.wip')?.dispatchEvent(new MouseEvent('mousedown', {bubbles: true, button: 0}))`);
    await waitFor("conflicted file", () =>
      js(`return [...document.querySelectorAll('.wip-panel .file-row')].some(r => r.textContent.includes('conflict.txt'))`),
    );
    await js(`[...document.querySelectorAll('.wip-panel .file-row')].find(r => r.textContent.includes('conflict.txt')).click()`);
    await waitFor("conflict view", () => js("return !!document.querySelector('.conflict-block')"));
    await shot("08-conflict");
    await js(`[...document.querySelectorAll('.conflict-choices button')].find(b => b.textContent === 'Both').click()`);
    await shot("09-conflict-chosen");
    await js(`[...document.querySelectorAll('.diff-header button')].find(b => b.textContent.includes('Save')).click()`);
    await waitFor("resolved", () => !git("diff", "--name-only", "--diff-filter=U"));
    await waitFor("continue enabled", () =>
      js(`const b = [...document.querySelectorAll('.op-banner button')].find(b => b.textContent === 'Continue'); return b && !b.disabled`),
    );
    await js(`[...document.querySelectorAll('.op-banner button')].find(b => b.textContent === 'Continue').click()`);
    await waitFor("merge committed", () => git("log", "-1", "--format=%p").split(" ").length === 2);
    const content = git("show", "HEAD:conflict.txt");
    if (content !== "ours\ntheirs") throw new Error(`unexpected content: ${JSON.stringify(content)}`);
    await waitFor("banner gone", () => js("return !document.querySelector('.op-banner')"));
    await shot("10-merged");
  });

  await step("undo takes the merge back", async () => {
    await waitFor("undo enabled", () =>
      js(`const b = [...document.querySelectorAll('.tool-btn')].find(b => b.textContent.includes('Undo')); return b && !b.disabled && b.title.includes('merge')`),
    );
    await js(`[...document.querySelectorAll('.tool-btn')].find(b => b.textContent.includes('Undo')).click()`);
    await waitFor("merge undone", () => git("log", "-1", "--format=%s") === "Our change");
    await waitFor("graph without merge", () =>
      js("return ![...document.querySelectorAll('.graph-row')].some(r => r.textContent.includes(\"Merge branch 'side'\"))"),
    );
    await shot("11-undone");
  });

  await step("reflog brings the undone merge back as a branch", async () => {
    await click(".repo-btn");
    await js(`[...document.querySelectorAll('.menu-item')].find(b => b.textContent.includes('Reflog')).click()`);
    await waitFor("reflog rows", () => js("return document.querySelectorAll('.reflog-row').length > 3"));
    // The merge that undo removed is no longer on a branch.
    await js(`const row = [...document.querySelectorAll('.reflog-row')].find(r => r.textContent.includes("Merge branch 'side'") && r.classList.contains('orphan'));
              row.dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, clientX: 500, clientY: 300}))`);
    await shot("12-reflog");
    await js(`[...document.querySelectorAll('.menu-item')].find(b => b.textContent.includes('Create branch here')).click()`);
    await waitFor("dialog", () => js("return !!document.querySelector('.modal input')"));
    await type(".modal input", "recovered");
    await js(`document.querySelector('.modal input[type=checkbox]').click()`); // don't check it out
    await click(".modal button[type=submit]");
    await waitFor("branch at merge", () => git("log", "-1", "--format=%s", "recovered").startsWith("Merge branch 'side'"));
    await js(`document.querySelector('.diff-header .icon-btn[title^="Close"]').click()`);
  });

  await step("clones a repository with progress and opens it", async () => {
    await click(".repo-btn");
    await js(`[...document.querySelectorAll('.menu-item')].find(b => b.textContent.includes('Clone repository')).click()`);
    await waitFor("clone dialog", () => js("return !!document.querySelector('.modal.wide')"));
    const inputs = "document.querySelectorAll('.modal.wide input')";
    // Set React-controlled inputs the way typing would.
    await js(
      `const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
       const [u, p] = ${inputs};
       set.call(u, arguments[0]); u.dispatchEvent(new Event('input', {bubbles: true}));
       set.call(p, arguments[1]); p.dispatchEvent(new Event('input', {bubbles: true}));`,
      join(demo, "origin.git"),
      work,
    );
    await waitFor("name derived", () => js(`return ${inputs}[2].value === 'origin'`));
    await shot("13-clone-dialog");
    await click(".modal.wide button[type=submit]");
    await waitFor("cloned repo opened", async () => (await text(".repo-name")) === "origin", 60000);
    await waitFor("cloned graph", () => js("return document.querySelectorAll('.graph-row').length > 3"));
    await waitFor("two tabs", () => js("return [...document.querySelectorAll('.tab')].map(t => t.textContent).join(',') === 'demo-app,origin'"));
    // Back to the first tab.
    await js(`document.querySelector('.tab').click()`);
    await waitFor("first tab active", async () => (await text(".repo-name")) === "demo-app");
    await js(`document.querySelectorAll('.tab')[1].click()`);
    await waitFor("second tab active", async () => (await text(".repo-name")) === "origin");
    await shot("14-cloned");
  });

  await step("opens a branch in a new worktree tab", async () => {
    await js(`[...document.querySelectorAll('.tab')].find(t => t.textContent.includes('demo-app')).click()`);
    await waitFor("demo tab", async () => (await text(".repo-name")) === "demo-app");
    await js(`const item = [...document.querySelectorAll('.side-item')].find(e => e.textContent.trim().startsWith('side'));
              item.dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, clientX: 100, clientY: 300}))`);
    await js(`[...document.querySelectorAll('.menu-item')].find(b => b.textContent.includes('new worktree')).click()`);
    await waitFor("dialog", () => js("return !!document.querySelector('.modal input')"));
    await click(".modal button[type=submit]");
    await waitFor("worktree tab", async () => (await text(".repo-name")) === "demo-app-side", 30000);
    await waitFor("worktree listed", () => js("return [...document.querySelectorAll('.side-section')].some(s => s.textContent.includes('Worktrees'))"));
    if (!git("worktree", "list").includes("demo-app-side")) throw new Error("worktree not created");
    await shot("15-worktree");
  });

  await step("lists submodules", async () => {
    await js(`[...document.querySelectorAll('.tab')].find(t => t.textContent === 'demo-app').click()`);
    await waitFor("demo tab", async () => (await text(".repo-name")) === "demo-app");
    git("-c", "protocol.file.allow=always", "submodule", "add", "-q", join(demo, "origin.git"), "vendor/origin");
    await waitFor("submodule section", () =>
      js("return [...document.querySelectorAll('.side-section')].some(s => s.textContent.includes('Submodules') && s.textContent.includes('vendor/origin'))"),
    );
  });

  await step("creates a new repository and makes the first commit", async () => {
    await click(".repo-btn");
    await js(`[...document.querySelectorAll('.menu-item')].find(b => b.textContent.includes('New repository')).click()`);
    await waitFor("init dialog", () => js("return !!document.querySelector('.modal.wide')"));
    await js(
      `const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
       const [parent, name] = document.querySelectorAll('.modal.wide input');
       set.call(parent, arguments[0]); parent.dispatchEvent(new Event('input', {bubbles: true}));
       set.call(name, 'fresh'); name.dispatchEvent(new Event('input', {bubbles: true}));`,
      work,
    );
    await click(".modal.wide button[type=submit]");
    await waitFor("fresh repo open", async () => (await text(".repo-name")) === "fresh");
    const fresh = join(work, "fresh");
    writeFileSync(join(fresh, "hello.txt"), "hello\n");
    await waitFor("untracked file listed", () =>
      js("return [...document.querySelectorAll('.wip-panel .file-row')].some(r => r.textContent.includes('hello.txt'))"),
    );
    await js(`[...document.querySelectorAll('.wip-panel .file-row')].find(r => r.textContent.includes('hello.txt')).querySelector('[title="Stage file"]').click()`);
    await waitFor("commit enabled after typing", async () => {
      await js(
        `const i = document.querySelector('.commit-summary-input');
         Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'Initial commit');
         i.dispatchEvent(new Event('input', {bubbles: true}));`,
      );
      return js("return !document.querySelector('.commit-form .primary-btn').disabled");
    });
    await click(".commit-form .primary-btn");
    await waitFor("first commit", () =>
      execFileSync("git", ["-C", fresh, "log", "--format=%s"], { encoding: "utf8" }).trim() === "Initial commit",
    );
    await waitFor("graph shows it", () =>
      js("return [...document.querySelectorAll('.graph-row')].some(r => r.textContent.includes('Initial commit'))"),
    );
    await shot("17-first-commit");
  });

  await step("pushes a new branch and sets its upstream", async () => {
    await js(`[...document.querySelectorAll('.tab')].find(t => t.textContent === 'origin').click()`);
    await waitFor("clone tab", async () => (await text(".repo-name")) === "origin");
    await js(`[...document.querySelectorAll('.tool-btn')].find(b => b.textContent.includes('Branch')).click()`);
    await waitFor("dialog", () => js("return !!document.querySelector('.modal input')"));
    await type(".modal input", "pushed-from-app");
    await click(".modal button[type=submit]");
    await waitFor("on new branch", async () => (await text(".branch-name")).includes("pushed-from-app"));
    await js(`[...document.querySelectorAll('.tool-btn')].find(b => b.textContent.includes('Push')).click()`);
    const bare = join(demo, "origin.git");
    await waitFor("branch on remote", () =>
      execFileSync("git", ["-C", bare, "branch", "--list", "pushed-from-app"], { encoding: "utf8" }).includes("pushed-from-app"),
    );
    await waitFor("upstream shown", () =>
      js("return [...document.querySelectorAll('.side-item')].some(e => e.textContent.includes('pushed-from-app')) && document.querySelector('.branch-name').title.includes('origin/pushed-from-app')"),
    );
  });

  await step("shows image changes side by side", async () => {
    await js(`[...document.querySelectorAll('.tab')].find(t => t.textContent === 'demo-app').click()`);
    await waitFor("demo tab", async () => (await text(".repo-name")) === "demo-app");
    // 1x1 PNGs: red, then blue.
    const red = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
    const blue = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwADBwIAMCbHYQAAAABJRU5ErkJggg==";
    writeFileSync(join(repo, "logo.png"), Buffer.from(red, "base64"));
    git("add", "logo.png");
    git("commit", "-q", "-m", "Add logo");
    writeFileSync(join(repo, "logo.png"), Buffer.from(blue, "base64"));
    git("commit", "-q", "-am", "Recolour logo");
    await waitFor("commit row", () => js("return [...document.querySelectorAll('.graph-row')].some(r => r.textContent.includes('Recolour logo'))"));
    await js(`[...document.querySelectorAll('.graph-row')].find(r => r.textContent.includes('Recolour logo')).dispatchEvent(new MouseEvent('mousedown', {bubbles: true, button: 0}))`);
    await waitFor("file list", () => js("return [...document.querySelectorAll('.commit-panel .file-row')].some(r => r.textContent.includes('logo.png'))"));
    await js(`[...document.querySelectorAll('.commit-panel .file-row')].find(r => r.textContent.includes('logo.png')).click()`);
    await waitFor("both images decoded", () =>
      js("const imgs = [...document.querySelectorAll('.image-diff img')]; return imgs.length === 2 && imgs.every(i => i.complete && i.naturalWidth === 1)"),
    );
    await shot("18-image-diff");
  });

  await wd("DELETE", `/session/${session}`);
  console.log(`e2e: ${results.length} steps passed`);
} catch (e) {
  console.error(`e2e failed: ${e.message}`);
  process.exitCode = 1;
} finally {
  cleanup();
}
