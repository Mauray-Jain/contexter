// Drive the built CLI as separate members, each with its own CONTEXTER_HOME, against the local stack.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { localEnv } from "./local.ts";

export const CLI = join(process.cwd(), "packages/cli/dist/contexter.mjs");
const MAIL = "http://127.0.0.1:55324/api/v1";

export function cliRunner(root: string) {
  const env = (who: string) => ({ ...process.env, CONTEXTER_HOME: join(root, who, ".home") });
  const cli = (who: string, args: string[], input?: string) =>
    execFileSync("node", [CLI, ...args], { encoding: "utf8", input, cwd: join(root, who), env: env(who) });

  async function login(who: string, email: string) {
    const { url, key } = localEnv();
    mkdirSync(join(root, who), { recursive: true });
    cli(who, ["setup", "--url", url, "--key", key]);
    await fetch(`${MAIL}/search?query=${encodeURIComponent(`to:${email}`)}`, { method: "DELETE" });
    const child = spawn("node", [CLI, "login", "--email", email], { cwd: join(root, who), env: env(who) });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    for (let i = 0; i < 40 && !out.includes("Enter"); i++) await new Promise((r) => setTimeout(r, 100));
    let code = "";
    for (let i = 0; i < 40 && !code; i++) {
      const list = await (await fetch(`${MAIL}/search?query=${encodeURIComponent(`to:${email}`)}&limit=1`)).json();
      if (list.messages?.[0]) {
        const msg = await (await fetch(`${MAIL}/message/${list.messages[0].ID}`)).json();
        code = /\b\d{6}\b/.exec(msg.Text)?.[0] ?? "";
      }
      if (!code) await new Promise((r) => setTimeout(r, 250));
    }
    child.stdin.end(`${code}\n`);
    await new Promise((r) => child.on("exit", r));
    assert.match(out, /Signed in as/);
  }

  return { cli, login, env };
}
