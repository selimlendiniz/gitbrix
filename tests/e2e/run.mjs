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
const app = join(root, "src-tauri/target/debug/gitbrix");
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
  start("tauri-driver", ["--port", String(PORT)], {
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
    await shot("07-conflict");
    await js(`[...document.querySelectorAll('.conflict-choices button')].find(b => b.textContent === 'Both').click()`);
    await shot("08-conflict-chosen");
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
    await shot("09-merged");
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
    await shot("10-clone-dialog");
    await click(".modal.wide button[type=submit]");
    await waitFor("cloned repo opened", async () => (await text(".repo-name")) === "origin", 60000);
    await waitFor("cloned graph", () => js("return document.querySelectorAll('.graph-row').length > 3"));
    await shot("11-cloned");
  });

  await wd("DELETE", `/session/${session}`);
  console.log(`e2e: ${results.length} steps passed`);
} catch (e) {
  console.error(`e2e failed: ${e.message}`);
  process.exitCode = 1;
} finally {
  cleanup();
}
