import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CliError } from "./client.ts";

const CALLBACK_PORT = 54545;
const CALLBACK_URL = `http://127.0.0.1:${CALLBACK_PORT}/callback`;

function openBrowser(url: string) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawn(cmd, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref();
}

// GitHub sign-in via PKCE: open the browser, catch the redirect on a local port,
// exchange the code for a session.
export async function loginWithGithub(sb: SupabaseClient) {
  const { data, error } = await sb.auth.signInWithOAuth({
    provider: "github",
    options: { redirectTo: CALLBACK_URL, skipBrowserRedirect: true },
  });
  if (error || !data.url) throw new CliError(error?.message ?? "could not start GitHub sign-in");

  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", CALLBACK_URL);
      if (url.pathname !== "/callback") return void res.writeHead(404).end();
      const code = url.searchParams.get("code");
      const err = url.searchParams.get("error_description");
      res.writeHead(200, { "content-type": "text/plain" })
        .end(code ? "Signed in to contexter. You can close this tab." : `Sign-in failed: ${err}`);
      server.close();
      code ? resolve(code) : reject(new CliError(err ?? "sign-in failed"));
    });
    server.listen(CALLBACK_PORT, "127.0.0.1", () => {
      console.log(`Opening your browser to sign in with GitHub…\nIf it doesn't open, visit:\n${data.url}`);
      openBrowser(data.url);
    });
    setTimeout(() => { server.close(); reject(new CliError("timed out waiting for sign-in")); }, 5 * 60_000);
  });

  const res = await sb.auth.exchangeCodeForSession(code);
  if (res.error) throw new CliError(res.error.message);
  return res.data.user;
}

// Email one-time code. Works on the local stack (codes land in the mail viewer) and as a
// fallback where GitHub isn't configured. `code` can be passed for non-interactive use.
export async function loginWithEmail(sb: SupabaseClient, email: string, code?: string) {
  if (!code) {
    const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
    if (error) throw new CliError(error.message);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    // If stdin ends before a full line arrives, fail loudly instead of exiting silently.
    const closed = new Promise<never>((_, reject) =>
      rl.once("close", () => reject(new CliError("no code entered"))));
    code = (await Promise.race([rl.question(`Enter the 6-digit code sent to ${email}: `), closed])).trim();
    rl.close();
  }
  const { data, error } = await sb.auth.verifyOtp({ email, token: code, type: "email" });
  if (error || !data.user) throw new CliError(error?.message ?? "invalid code");
  return data.user;
}
