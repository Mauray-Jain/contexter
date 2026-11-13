// Watching Modal jobs from whichever machine is responsible for them.
// `modal run --detach` keeps a job running on Modal after the local process is gone. Its run
// records the Modal app id and profile name; the member whose machine watches it (the starter via
// `contexter modal track`, or whoever accepted a handoff of it) runs a small background watcher
// that asks Modal about the job every minute and reports progress, log tail and the final status.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SupabaseClient } from "@supabase/supabase-js";
import * as core from "../../../supabase/functions/_shared/contexter.ts";
import { getClient, requireUser } from "./client.ts";
import { home } from "./config.ts";
import { lastLine } from "./run.ts";

// Tests shorten these; real watchers look once a minute and quit after 10 idle minutes.
const POLL_MS = Number(process.env.CONTEXTER_MODAL_POLL_MS) || 60_000;
const IDLE_POLLS = Number(process.env.CONTEXTER_MODAL_IDLE_POLLS) || 10;
const MODAL_TIMEOUT_MS = 90_000;

const pidPath = join(home, "modal-daemon.pid");
const logPath = join(home, "modal-daemon.log");
// Works from src/ (tsx) and dist/ (bundle) alike: the repo root is three levels up from either.
const bundle = join(resolve(dirname(fileURLToPath(import.meta.url)), "../../.."), "packages/cli/dist/contexter.mjs");

// "View run at https://modal.com/apps/<workspace>/<environment>/ap-…", printed by `modal run`.
export function parseModalApp(output: string): { app_id: string; environment?: string } | undefined {
  const url = /modal\.com\/apps\/[^/\s]+\/([^/\s]+)\/(ap-[A-Za-z0-9]{4,64})\b/.exec(output);
  if (url) return { app_id: url[2], ...(url[1] !== "main" ? { environment: url[1] } : {}) };
  const bare = /\b(ap-[A-Za-z0-9]{6,64})\b/.exec(output);
  return bare ? { app_id: bare[1] } : undefined;
}

// The Modal profile a `modal` command here would use: MODAL_PROFILE, else the active profile in
// the Modal config. Only its name is shared, never its token.
export function activeModalProfile(): string | undefined {
  if (process.env.MODAL_PROFILE) return process.env.MODAL_PROFILE;
  const path = process.env.MODAL_CONFIG_PATH ?? join(homedir(), ".modal.toml");
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return undefined; }
  const sections = [...text.matchAll(/^\[([^\]]+)\]([\s\S]*?)(?=^\[|$(?![\s\S]))/gm)];
  const active = sections.find((m) => /^\s*active\s*=\s*true\b/m.test(m[2]));
  return (active ?? (sections.length === 1 ? sections[0] : undefined))?.[1].trim();
}

// The modal CLI: CONTEXTER_MODAL_BIN, then a project virtualenv, then PATH.
function modalBin(cwd: string): string {
  if (process.env.CONTEXTER_MODAL_BIN) return process.env.CONTEXTER_MODAL_BIN;
  for (let dir = cwd; ; dir = dirname(dir)) {
    const venv = join(dir, ".venv", "bin", "modal");
    if (existsSync(venv)) return venv;
    if (dirname(dir) === dir) return "modal";
  }
}

function modalCli(args: string[], job: core.ModalJob, cwd: string): Promise<string> {
  return new Promise((done, fail) => {
    const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1", TERM: "dumb" };
    if (job.profile) env.MODAL_PROFILE = job.profile;
    if (job.environment) env.MODAL_ENVIRONMENT = job.environment;
    const child = spawn(modalBin(cwd), args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), MODAL_TIMEOUT_MS);
    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      fail(new Error(err.code === "ENOENT" ? "the modal CLI isn't installed on this machine" : err.message));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) return done(out);
      // Modal prints errors in a box; keep just the words.
      const message = out.replace(/[─│╭╮╰╯]+/g, " ").replace(/\s+/g, " ").replace(/^\s*Error\s*/i, "").trim();
      fail(new Error(`${job.profile ? `profile ${job.profile}: ` : ""}${core.truncate(message || `modal exited ${code}`, 200)}`));
    });
  });
}

export interface ModalCheck {
  status: "running" | "succeeded" | "failed" | "cancelled";
  progress: string;
  logTail: string;
}

// Where a Modal job stands. A stopped app doesn't say whether its code succeeded, so that's read
// from the end of its logs: a traceback or error means failed.
export async function checkModalJob(job: core.ModalJob, cwd: string): Promise<ModalCheck> {
  const info = JSON.parse(await modalCli(["app", "info", job.app_id, "--json"], job, cwd)) as {
    lifecycle?: { state?: string; stopped_by?: string | null };
  };
  const logTail = (await modalCli(["app", "logs", job.app_id, "--tail", "40"], job, cwd).catch(() => "")).slice(-4000);
  const state = info.lifecycle?.state ?? "unknown";
  if (state !== "stopped") return { status: "running", progress: lastLine(logTail) || `Modal: ${state}`, logTail };
  const failed = /Traceback \(most recent call last\)|^\s*\w*(Error|Exception)\b|Runner failed/m.test(logTail);
  return {
    status: info.lifecycle?.stopped_by ? "cancelled" : failed ? "failed" : "succeeded",
    progress: info.lifecycle?.stopped_by ? `stopped by ${info.lifecycle.stopped_by}` : lastLine(logTail) || "Modal app finished",
    logTail,
  };
}

function daemonPid(): number | undefined {
  try {
    const pid = Number(readFileSync(pidPath, "utf8"));
    process.kill(pid, 0);
    return pid;
  } catch {
    return undefined;
  }
}

// Start the background watcher if this user's machine has Modal jobs to watch and it isn't
// running yet. Quietly does nothing otherwise.
export async function ensureModalDaemon(db: core.Db, userId: string, cwd: string): Promise<boolean> {
  if (daemonPid() || !(await core.modalRunsToWatch(db, userId)).length) return false;
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const log = openSync(logPath, "a");
  spawn(process.execPath, [bundle, "modal", "daemon"], { cwd, detached: true, stdio: ["ignore", log, log], env: process.env })
    .unref();
  return true;
}

// The watcher itself: every POLL_MS, check each Modal job this user's machine is responsible for.
// Stops after IDLE_POLLS checks with nothing to watch.
export async function modalDaemon() {
  const other = daemonPid();
  if (other && other !== process.pid) return console.log(`A contexter Modal watcher is already running (pid ${other}).`);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(pidPath, String(process.pid));
  const cleanup = () => { if (daemonPid() === process.pid) rmSync(pidPath, { force: true }); };
  process.on("exit", cleanup);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => process.exit(0));

  const sb = getClient();
  const user = await requireUser(sb);
  const cwd = process.cwd();
  console.log(`${new Date().toISOString()} watching Modal jobs for ${user.email ?? user.id} from ${cwd}`);
  for (let idle = 0; idle < IDLE_POLLS;) {
    try {
      await sb.auth.getSession(); // refresh the access token on long watches
      const runs = (await core.modalRunsToWatch(sb as unknown as core.Db, user.id)).filter((r) => r.external?.modal);
      idle = runs.length ? 0 : idle + 1;
      for (const r of runs) await watchOnce(sb, r, cwd);
    } catch (err) {
      console.log(`${new Date().toISOString()} ${err instanceof Error ? err.message : err}`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  console.log(`${new Date().toISOString()} nothing left to watch; stopping`);
}

async function watchOnce(sb: SupabaseClient, r: core.Run, cwd: string) {
  const db = sb as unknown as core.Db;
  let check: ModalCheck;
  try {
    check = await checkModalJob(r.external.modal!, cwd);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await core.reportRunWatch(db, r.id, message);
    console.log(`${new Date().toISOString()} run #${r.number}: ${message}`);
    return;
  }
  // Someone else may have taken it over since the list was read: then leave it to them.
  if (!(await core.reportRunWatch(db, r.id))) return;
  await core.updateRun({ db }, r.id, {
    progress: check.progress || undefined, logTail: check.logTail || undefined,
    status: check.status === "running" ? undefined : check.status,
  });
  if (check.status !== "running") console.log(`${new Date().toISOString()} run #${r.number} ${check.status}`);
}
