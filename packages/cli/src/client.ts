import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { authStorage, loadConfig } from "./config.ts";

export class CliError extends Error {}

export function getClient(): SupabaseClient {
  const { url, publishableKey } = loadConfig();
  if (!url || !publishableKey) {
    throw new CliError("Not configured. Run: contexter setup --url <supabase-url> --key <publishable-key>");
  }
  return createClient(url, publishableKey, {
    auth: { storage: authStorage, persistSession: true, autoRefreshToken: false, flowType: "pkce" },
  });
}

export async function requireUser(sb: SupabaseClient) {
  const { data, error } = await sb.auth.getUser();
  if (error || !data.user) throw new CliError("Not signed in. Run: contexter login");
  return data.user;
}

export function requireWorkspace() {
  const ws = loadConfig().activeWorkspace;
  if (!ws) throw new CliError("No active workspace. Run: contexter init, contexter join, or contexter use");
  return ws;
}

// Turn a PostgREST/Postgres error into a readable message, keeping our RPC hints.
// Without an error, data is present for selects/RPCs; plain inserts return null and callers ignore it.
export function check<T>(res: { data: T; error: { message: string; hint?: string | null } | null }): NonNullable<T> {
  if (res.error) {
    throw new CliError(res.error.hint ? `${res.error.message} (${res.error.hint})` : res.error.message);
  }
  return res.data as NonNullable<T>;
}
