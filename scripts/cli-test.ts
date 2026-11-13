// CLI feature test: templates, export (pandoc), git mirror, live watch, search/why/memory, chat skill.
// Run: npm run build && npm run test:cli (with `npm run db:start` up).
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI, cliRunner } from "./lib/cli.ts";
import { signIn } from "./lib/local.ts";
import * as core from "../supabase/functions/_shared/contexter.ts";

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

await step("chat skill packages as a zip", () => {
  const zip = join(root, "skill.zip");
  const out = cli("writer", ["install", "chat", "-o", zip]);
  assert.match(out, /Settings → Connectors → Add custom connector → URL: http:\/\/127\.0\.0\.1:55321\/functions\/v1\/mcp/);
  assert.match(execFileSync("unzip", ["-l", zip], { encoding: "utf8" }), /contexter\/SKILL\.md/);
});

console.log(`\n${passed} CLI checks passed`);
process.exit(0);
