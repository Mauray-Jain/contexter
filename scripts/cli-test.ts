// CLI feature test: templates, export (pandoc), git mirror, live watch, search/why/memory, chat skill.
// Run: npm run build && npm run test:cli (with `npm run db:start` up).
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { copyFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI, cliRunner } from "./lib/cli.ts";
import { signIn } from "./lib/local.ts";
import * as core from "../supabase/functions/_shared/contexter.ts";
import { activeModalProfile, checkModalJob, parseModalApp } from "../packages/cli/src/modal.ts";

const run = Date.now().toString(36);
const root = mkdtempSync(join(tmpdir(), "contexter-cli-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const { cli, login, env } = cliRunner(root);

let passed = 0;
async function step(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed++; console.log(`ok - ${name}`); } catch (err) { console.log(`not ok - ${name}`); throw err; }
}

const email = `writer-${run}@cli.local`;
await login("writer", email);
const slug = `cli-${run}`;

await step("every template initialises a workspace", () => {
  for (const t of ["blank", "research-paper", "software", "book", "spec", "knowledge-base"]) {
    const out = cli("writer", ["init", `${slug}-${t}`.slice(0, 48), "--handle", "writer", "--template", t]);
    assert.match(out, new RegExp(`from template ${t}`));
  }
  cli("writer", ["use", `${slug}-research-paper`.slice(0, 48)]);
  assert.match(cli("writer", ["status"]), /sections\/method\s+outline\s+v0/);
});

// Content through the shared core, as Claude would write it via MCP.
const w = await signIn(email);
const ctx = await core.loadCtx(w.sb, w.userId, { workspace: `${slug}-research-paper`.slice(0, 48), session: null });
await core.writeUnit(ctx, "sections/introduction", "# Introduction\n\nDense retrieval is strong [@karpukhin2020].", 0, "Intro draft", "Sets up the claim.");
await core.writeUnit(ctx, "sections/method", "# Method\n\nWe re-rank with a cross-encoder.", 0, "Method draft");
await core.writeUnit(ctx, "refs/bibliography",
  "@inproceedings{karpukhin2020,\n  title={Dense Passage Retrieval for Open-Domain Question Answering},\n  author={Karpukhin, Vladimir and others},\n  booktitle={EMNLP},\n  year={2020}\n}\n", 0, "Add DPR");
await core.addRecord(ctx, "decision", "Use cross-encoder re-ranking", "Best quality per latency on the pilot.", ["sections/method"]);

await step("export to markdown in section order, with reasoning appendix", () => {
  const out = join(root, "paper.md");
  cli("writer", ["export", "--with-reasoning", "-o", out]);
  const md = readFileSync(out, "utf8");
  assert.ok(md.indexOf("# Introduction") < md.indexOf("# Method"), "sections are in order");
  assert.doesNotMatch(md, /@inproceedings/, "bibliography is not part of the paper body");
  assert.match(md, /# Appendix: reasoning record/);
  assert.match(md, /## D-0001 Use cross-encoder re-ranking/);
});

await step("export through pandoc resolves citations (html, docx)", () => {
  const html = join(root, "paper.html");
  cli("writer", ["export", "--format", "html", "-o", html]);
  const text = readFileSync(html, "utf8");
  assert.match(text, /Karpukhin/, "citation rendered from the bibliography unit");
  assert.doesNotMatch(text, /\[@karpukhin2020\]/);
  const docx = join(root, "paper.docx");
  cli("writer", ["export", "--format", "docx", "-o", docx]);
  assert.equal(readFileSync(docx).subarray(0, 2).toString(), "PK", "docx is a zip");
});

await step("export to pdf (when a PDF engine is installed)", () => {
  const engines = ["tectonic", "xelatex", "pdflatex", "typst", "weasyprint", "wkhtmltopdf"];
  if (!engines.some((e) => spawnSync("which", [e]).status === 0)) return console.log("   (skipped: no PDF engine)");
  const pdf = join(root, "paper.pdf");
  cli("writer", ["export", "--format", "pdf", "--with-reasoning", "-o", pdf]);
  assert.equal(readFileSync(pdf).subarray(0, 4).toString(), "%PDF");
});

await step("mirror writes files and commits, and is idempotent", () => {
  const dir = join(root, "mirror");
  assert.match(cli("writer", ["mirror", dir]), /committed/);
  assert.ok(existsSync(join(dir, "sections/method.md")));
  assert.ok(readdirSync(join(dir, "records/decisions"))[0].startsWith("D-0001-use-cross-encoder"));
  assert.match(readFileSync(join(dir, "OVERVIEW.md"), "utf8"), /sections\/method · outline · v1/);
  assert.match(cli("writer", ["mirror", dir]), /already up to date/);
  assert.equal(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: dir, encoding: "utf8" }).trim(), "1");
});

await step("search, why and memory", () => {
  assert.match(cli("writer", ["search", "cross-encoder"]), /\[unit\] sections\/method/);
  assert.match(cli("writer", ["why", "sections/method"]), /D-0001 decision .* Use cross-encoder re-ranking/);
  assert.match(cli("writer", ["memory"]), /shared memory/);
});

await step("watch streams teammates' events live", async () => {
  await login("teammate", `teammate-${run}@cli.local`);
  const code = /^ {2}(\S+)$/m.exec(cli("writer", ["invite"]))![1];
  cli("teammate", ["join", code, "--handle", "teammate"]);
  const child = spawn("node", [CLI, "watch"], { cwd: join(root, "writer"), env: env("writer") });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  // watch prints "Watching" once the realtime subscription is live; CI runners can be slow to get there.
  for (let i = 0; i < 300 && !out.includes("Watching"); i++) await new Promise((r) => setTimeout(r, 100));
  const t = await signIn(`teammate-${run}@cli.local`);
  const tctx = await core.loadCtx(t.sb, t.userId, { workspace: `${slug}-research-paper`.slice(0, 48), session: null });
  await core.mention(tctx, ["writer"], "watch me arrive");
  for (let i = 0; i < 150 && !out.includes("watch me arrive"); i++) await new Promise((r) => setTimeout(r, 100));
  child.kill();
  assert.match(out, /teammate · .* · to @writer: "watch me arrive"/);
});

await step("run reports a job's progress, log and exit to the team", async () => {
  const job = `for (let i = 1; i <= 4; i++) setTimeout(() => console.log("\\x1b[32mstep " + i + "/4\\x1b[0m"), i * 150);
setTimeout(() => { console.error("boom"); process.exit(3); }, 800);`;
  const r = spawnSync("node", [CLI, "run", "-t", "soak test", "-w", "teammate", "--", "node", "-e", job], {
    cwd: join(root, "writer"), env: { ...env("writer"), CONTEXTER_RUN_HEARTBEAT_MS: "100" }, encoding: "utf8",
  });
  assert.equal(r.status, 3, "the job's exit code is passed on");
  assert.match(r.stdout, /step 4\/4/, "output passes through");
  assert.match(r.stderr, /\[contexter\] run #(\d+) .*\n[\s\S]*run #\1 failed \(exit 3\)/);
  const n = Number(/run #(\d+)/.exec(r.stderr)![1]);
  const reported = await core.getRun(ctx, n);
  assert.equal(reported.status, "failed");
  assert.equal(reported.exit_code, 3);
  assert.equal(reported.reporter, "wrapper");
  assert.equal(reported.progress, "boom");
  assert.match(reported.log_tail!, /step 1\/4\nstep 2\/4\nstep 3\/4\nstep 4\/4\nboom/, "the log tail is captured without colour codes");
  const t = await signIn(`teammate-${run}@cli.local`);
  const tctx = await core.loadCtx(t.sb, t.userId, { workspace: ctx.ws.slug, session: null });
  const feed = await core.feedDelta(tctx);
  assert.match(feed, new RegExp(`writer · .* · run #${n} "soak test" on \\S+ failed \\(exit 3\\) after \\d+s; last: "boom"  ← mentions you`));
  assert.match(cli("writer", ["runs", String(n)]), /log tail ──────\nstep 1\/4/);
});

await step("Ctrl-C on run cancels the job and says so", async () => {
  const child = spawn("node", [CLI, "run", "-t", "long one", "--", "sleep 30"], { cwd: join(root, "writer"), env: env("writer") });
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  for (let i = 0; i < 100 && !/run #\d+/.test(err); i++) await new Promise((r) => setTimeout(r, 100));
  child.kill("SIGINT");
  const code = await new Promise((r) => child.on("exit", r));
  assert.notEqual(code, 0);
  const n = Number(/run #(\d+)/.exec(err)![1]);
  assert.equal((await core.getRun(ctx, n)).status, "cancelled");
});

// A fake modal CLI on PATH-like terms: named `modal`, state in a JSON file the test edits.
const fakeBin = join(root, "bin");
mkdirSync(fakeBin, { recursive: true });
copyFileSync(join(process.cwd(), "scripts/lib/fake-modal.mjs"), join(fakeBin, "modal"));
chmodSync(join(fakeBin, "modal"), 0o755);
const modalState = join(root, "modal-state.json");
const setApp = (id: string, app: Record<string, unknown>) => {
  const st = JSON.parse(readFileSync(modalState, "utf8"));
  st.apps[id] = { ...st.apps[id], ...app };
  writeFileSync(modalState, JSON.stringify(st));
};
writeFileSync(modalState, JSON.stringify({ apps: {} }));
Object.assign(process.env, {
  FAKE_MODAL_STATE: modalState, CONTEXTER_MODAL_BIN: join(fakeBin, "modal"),
  CONTEXTER_MODAL_POLL_MS: "200", CONTEXTER_MODAL_IDLE_POLLS: "3",
});
async function until<T>(what: string, fn: () => Promise<T | undefined | false>, ms = 30_000): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 150))) {
    const v = await fn();
    if (v) return v;
  }
  throw new Error(`timed out waiting for ${what}`);
}

await step("Modal: app ids, profiles and job state are read the way Modal reports them", async () => {
  assert.deepEqual(parseModalApp("✓ Initialized. View run at https://modal.com/apps/team/main/ap-AbC123xyz"), { app_id: "ap-AbC123xyz" });
  assert.deepEqual(parseModalApp("View run at https://modal.com/apps/team/staging/ap-AbC123xyz"),
    { app_id: "ap-AbC123xyz", environment: "staging" });
  const cfg = join(root, "modal.toml");
  writeFileSync(cfg, '[alpha]\ntoken_id = "x"\ntoken_secret = "y"\n\n[venice67]\ntoken_id = "x"\ntoken_secret = "y"\nactive = true\n');
  const saved = process.env.MODAL_PROFILE;
  delete process.env.MODAL_PROFILE;
  process.env.MODAL_CONFIG_PATH = cfg;
  assert.equal(activeModalProfile(), "venice67", "the active profile's name, never its token");
  delete process.env.MODAL_CONFIG_PATH;
  if (saved) process.env.MODAL_PROFILE = saved;

  setApp("ap-crash1", { state: "stopped", stopped_by: null, logs: ["epoch 3", "Traceback (most recent call last):", "  File x", "RuntimeError: CUDA out of memory"] });
  setApp("ap-ok1", { state: "stopped", stopped_by: null, logs: ["epoch 10", "done: acc 0.91"] });
  setApp("ap-stop1", { state: "stopped", stopped_by: "krish", logs: ["epoch 2"] });
  setApp("ap-live1", { state: "ephemeral (detached)", stopped_by: null, logs: ["epoch 4/10"] });
  const cwd = join(root, "writer");
  assert.equal((await checkModalJob({ app_id: "ap-crash1" }, cwd)).status, "failed");
  assert.deepEqual(await checkModalJob({ app_id: "ap-ok1" }, cwd), { status: "succeeded", progress: "done: acc 0.91", logTail: "epoch 10\ndone: acc 0.91\n" });
  assert.equal((await checkModalJob({ app_id: "ap-stop1" }, cwd)).status, "cancelled");
  assert.equal((await checkModalJob({ app_id: "ap-live1" }, cwd)).progress, "epoch 4/10");
  await assert.rejects(checkModalJob({ app_id: "ap-live1", profile: "missing" }, cwd), /profile missing: Token not found/);
});

await step("Modal: a detached job outlives its machine, and the teammate it's handed to watches it", async () => {
  // writer starts a detached Modal job under contexter run, then the laptop dies (the whole process group).
  const app = `ap-job${run}`;
  const wrapper = spawn("node", [CLI, "run", "-t", "train family", "--", join(fakeBin, "modal"), "run", "--detach", "bl_modal.py"], {
    cwd: join(root, "writer"), env: { ...env("writer"), ...process.env, CONTEXTER_HOME: env("writer").CONTEXTER_HOME, FAKE_MODAL_APP: app, MODAL_PROFILE: "venice67" },
    detached: true,
  });
  let err = "";
  wrapper.stderr.on("data", (d) => (err += d));
  const n = await until("the run", async () => Number(/run #(\d+)/.exec(err)?.[1]));
  const recorded = await until("the Modal app on the run", async () => {
    const r = await core.getRun(ctx, n);
    return r.external?.modal ? r : undefined;
  });
  assert.deepEqual(recorded.external.modal, { app_id: app, profile: "venice67" }, "app id and profile name, no token");
  process.kill(-wrapper.pid!, "SIGKILL");
  setApp(app, { logs: ["epoch 6/10", "epoch 7/10"] });

  // writer hands it to teammate; teammate sees which Modal job moves to their machine.
  const t = await signIn(`teammate-${run}@cli.local`);
  const tctx = await core.loadCtx(t.sb, t.userId, { workspace: ctx.ws.slug, session: null });
  const h = Number(/Handoff #(\d+)/.exec(await core.createHandoff(ctx, {
    to: "teammate", title: "Watch the family training", summary: "Training runs detached on Modal; my limit is out.",
  }))![1]);
  assert.match(await core.handoffsBlock(tctx), new RegExp(`Modal jobs this user's machine will watch on accepting: run #${n} "train family" \\(${app}, profile venice67\\)`));

  // Accepting starts teammate's watcher, which reports what Modal says.
  const accepted = cli("teammate", ["handoffs", String(h), "--accept"]);
  assert.match(accepted, new RegExp(`now watches the Modal job\\(s\\) run #${n} \\(${app}\\)`));
  assert.match(accepted, /Started this machine's Modal watcher/);
  const watched = await until("the watcher's first check", async () => {
    const r = await core.getRun(ctx, n);
    return r.watched_at && r.progress === "epoch 7/10" ? r : undefined;
  });
  assert.equal(watched.reporter, "modal");
  assert.equal(watched.watcher_user, t.userId);
  // A fresh context: the one above was loaded before teammate joined.
  const now = await core.loadCtx(w.sb, w.userId, { workspace: ctx.ws.slug, session: null });
  assert.match(await core.runsBlock(now), new RegExp(`run #${n} · you · "train family" on Modal \\(${app}, profile venice67\\) · running .* · epoch 7/10 · watched by teammate's machine, checked just now`));

  // The job finishes on Modal: the watcher reports it, then stops with nothing left to watch.
  setApp(app, { state: "stopped", logs: ["epoch 10/10", "done: acc 0.91"] });
  const done = await until("the end of the job", async () => {
    const r = await core.getRun(ctx, n);
    return r.status !== "running" ? r : undefined;
  });
  assert.equal(done.status, "succeeded");
  assert.equal(done.progress, "done: acc 0.91");
  await until("the watcher to stop", async () => !existsSync(join(root, "teammate", ".home", "modal-daemon.pid")));
});

await step("Modal: a watcher without the job's profile says so instead of going quiet", async () => {
  const app = `ap-nokey${run}`;
  setApp(app, { state: "ephemeral (detached)", stopped_by: null, logs: [] });
  const out = cli("writer", ["modal", "track", app, "-t", "keyless job", "--profile", "missing"]);
  const n = Number(/as run #(\d+)/.exec(out)![1]);
  const r = await until("the watcher's report", async () => {
    const x = await core.getRun(ctx, n);
    return x.watch_error ? x : undefined;
  });
  assert.match(r.watch_error!, /profile missing: Token not found/);
  assert.match(await core.runsBlock(ctx), new RegExp(`run #${n} · you · "keyless job" on Modal \\(${app}, profile missing\\) · running .* · your machine can't check it: profile missing: Token not found`));
  await core.updateRun(ctx, r.id, { status: "cancelled" });
  await until("the watcher to stop", async () => !existsSync(join(root, "writer", ".home", "modal-daemon.pid")));
});

await step("chat skill packages as a zip", () => {
  const zip = join(root, "skill.zip");
  const out = cli("writer", ["install", "chat", "-o", zip]);
  assert.match(out, /Settings → Connectors → Add custom connector → URL: http:\/\/127\.0\.0\.1:55321\/functions\/v1\/mcp/);
  assert.match(execFileSync("unzip", ["-l", zip], { encoding: "utf8" }), /contexter\/SKILL\.md/);
});

console.log(`\n${passed} CLI checks passed`);
process.exit(0);
