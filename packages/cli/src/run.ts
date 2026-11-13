// `contexter run -- <command>`: run a long job and keep the team posted. The job is registered as a
// run, its output passes through to this terminal unchanged, and every minute the last line
// (progress) and the end of the output (log tail) go to the workspace as a heartbeat. When it
// exits, its status and exit code are reported and its watchers are told.
// A `modal run` job also gets its Modal app id recorded, so if this machine goes away while a
// detached job is still running on Modal, a teammate's machine can take over watching it.
import { type ChildProcess, spawn } from "node:child_process";
import { hostname } from "node:os";
import { constants } from "node:os";
import type { SupabaseClient } from "@supabase/supabase-js";
import * as core from "../../../supabase/functions/_shared/contexter.ts";
import { projectWorkspace } from "./hooks.ts";
import { activeModalProfile, parseModalApp } from "./modal.ts";
import { cliCtx } from "./workspace.ts";

const TAIL_CHARS = 4000;
// Tests shorten the heartbeat; real runs report once a minute.
const HEARTBEAT_MS = Number(process.env.CONTEXTER_RUN_HEARTBEAT_MS) || 60_000;

// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g, "");

// The last non-empty line, counting \r as a line break so progress bars report their latest state.
export function lastLine(text: string): string {
  const lines = text.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);
  return core.truncate(lines.at(-1) ?? "", 300);
}

export async function runJob(command: string[], opts: { title?: string; host?: string; watch?: string[] }) {
  // Ctrl-C or a kill stops the job, which then counts as cancelled rather than failed. Installed
  // before anything else, so a stop that comes before the job has even started is still reported.
  let cancelled = false;
  let child: ChildProcess | undefined;
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => {
      cancelled = true;
      child?.kill(sig);
    });
  }

  const ctx = await cliCtx(projectWorkspace(process.cwd()));
  const sb = ctx.db as unknown as SupabaseClient;
  const text = command.join(" ");
  const run = await core.startRun(ctx, {
    title: opts.title ?? core.truncate(text, 120), host: opts.host ?? hostname(), command: text,
    watchers: (opts.watch ?? []).map((h) => h.replace(/^@/, "")), reporter: "wrapper",
  });

  // One argument runs through the shell, so `contexter run -- "make && ./bench"` works.
  child = command.length === 1
    ? spawn(command[0], { shell: true, stdio: ["inherit", "pipe", "pipe"] })
    : spawn(command[0], command.slice(1), { stdio: ["inherit", "pipe", "pipe"] });
  if (cancelled) child.kill("SIGINT"); // stopped while the run was being registered
  console.error(`[contexter] run #${run.number} in ${ctx.ws.slug}: teammates can follow it.`);

  let tail = "";
  const isModal = /(^|[\s/])modal\s+run\b/.test(text);
  const detached = isModal && /\s(--detach|-d)\b/.test(text);
  let modalApp: core.ModalJob | undefined;
  const capture = (out: NodeJS.WriteStream) => (chunk: Buffer) => {
    out.write(chunk);
    tail = (tail + stripAnsi(chunk.toString("utf8"))).slice(-TAIL_CHARS);
    const found = isModal && !modalApp ? parseModalApp(tail) : undefined;
    if (found) {
      modalApp = { ...found, profile: activeModalProfile() };
      core.setRunModal(ctx, run.id, modalApp).catch((err) =>
        console.error(`[contexter] couldn't record Modal app ${found.app_id} on run #${run.number}: ${err.message ?? err}`));
    }
  };
  child.stdout!.on("data", capture(process.stdout));
  child.stderr!.on("data", capture(process.stderr));

  let warned = false;
  const report = async (final?: { status: string; exitCode: number }) => {
    // Long jobs outlive the access token: refresh it from the stored session first.
    await sb.auth.getSession();
    return core.updateRun(ctx, run.id, {
      progress: lastLine(tail) || undefined, logTail: tail || undefined, status: final?.status, exitCode: final?.exitCode,
    });
  };
  const heartbeat = setInterval(() => {
    report().then((r) => {
      // Handed off: a teammate's machine watches the Modal job now, so stop reporting from here.
      if (r.watcher_user && r.watcher_user !== ctx.userId) {
        clearInterval(heartbeat);
        console.error(`[contexter] run #${run.number} is now watched from a teammate's machine; this terminal stops reporting it.`);
      }
    }).catch((err) => {
      if (!warned) console.error(`[contexter] couldn't report run #${run.number} (will keep trying): ${err.message ?? err}`);
      warned = true;
    });
  }, HEARTBEAT_MS);

  const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
    child!.on("error", (err) => {
      tail += `\n${err.message}`;
      resolve([127, null]);
    });
    child!.on("close", (c, s) => resolve([c, s]));
  });
  clearInterval(heartbeat);
  const exitCode = code ?? 128 + (signal ? constants.signals[signal] ?? 0 : 0);
  if (cancelled && detached && modalApp) {
    // Stopping `modal run --detach` here leaves the job running on Modal: the run stays open.
    console.error(`[contexter] the Modal job (${modalApp.app_id}) keeps running, so run #${run.number} stays open. ` +
      "Watch it from here with `contexter modal track " + `${modalApp.app_id} --run ${run.number}\`, or hand it off ` +
      "and a teammate's machine will watch it.");
    process.exit(exitCode);
  }
  const status = cancelled ? "cancelled" : exitCode === 0 ? "succeeded" : "failed";
  for (let attempt = 0; ; attempt++) {
    try {
      await report({ status, exitCode });
      break;
    } catch (err) {
      if (attempt >= 4) {
        console.error(`[contexter] couldn't report the end of run #${run.number}: ${err instanceof Error ? err.message : err}`);
        break;
      }
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  console.error(`[contexter] run #${run.number} ${status}${status === "succeeded" ? "" : ` (exit ${exitCode})`}.`);
  process.exit(exitCode);
}
