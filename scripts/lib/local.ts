// Test helpers for the local Supabase stack: sign users in with emailed codes (read from the
// local Mailpit), and build clients scoped to them.
import { execFileSync } from "node:child_process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const MAIL = "http://127.0.0.1:55324/api/v1";

export function localEnv() {
  const out = execFileSync("npx", ["supabase", "status", "-o", "env"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const get = (k: string) => new RegExp(`^${k}="(.*)"$`, "m").exec(out)?.[1] ?? "";
  return { url: get("API_URL"), key: get("PUBLISHABLE_KEY"), functions: `${get("API_URL")}/functions/v1` };
}

async function codeFor(email: string): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const list = await (await fetch(`${MAIL}/search?query=${encodeURIComponent(`to:${email}`)}&limit=1`)).json();
    const id = list.messages?.[0]?.ID;
    if (id) {
      const msg = await (await fetch(`${MAIL}/message/${id}`)).json();
      const code = /\b\d{6}\b/.exec(msg.Text)?.[0];
      if (code) return code;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no sign-in code mailed to ${email}`);
}

export async function signIn(email: string): Promise<{ sb: SupabaseClient; token: string; userId: string }> {
  const { url, key } = localEnv();
  const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  await fetch(`${MAIL}/search?query=${encodeURIComponent(`to:${email}`)}`, { method: "DELETE" });
  const sent = await sb.auth.signInWithOtp({ email });
  if (sent.error) throw sent.error;
  const { data, error } = await sb.auth.verifyOtp({ email, token: await codeFor(email), type: "email" });
  if (error || !data.session) throw error ?? new Error("no session");
  return { sb, token: data.session.access_token, userId: data.user!.id };
}
