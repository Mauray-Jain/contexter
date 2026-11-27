// Embeddings for the CLI, which can't run the model itself. Everything runs as the caller: the
// backlog is read under RLS and store_embeddings() checks membership, so no service role.
//
// POST { workspace, query }  -> { embedding }            and embeds a little more in the background
// POST { workspace, sweep: true } -> { embedded, remaining }  embeds for about a second (reindexing)
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";
import type { Db } from "../_shared/contexter.ts";
import { embedText, sweep, sweepInBackground } from "../_shared/embeddings.ts";

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type, apikey, x-client-info",
  "access-control-allow-methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const authz = req.headers.get("authorization") ?? "";
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authz } },
  });
  const { data: who } = await db.auth.getUser(authz.replace(/^Bearer\s+/i, ""));
  if (!who?.user) return json({ error: "sign in first" }, 401);

  let body: { workspace?: string; query?: unknown; sweep?: boolean };
  try { body = await req.json(); } catch { return json({ error: "body must be JSON" }, 400); }
  if (!body.workspace || !UUID.test(body.workspace)) return json({ error: "workspace must be a workspace id" }, 400);
  // RLS hides workspaces you aren't in, so this is the membership check.
  const { data: ws } = await db.from("workspaces").select("id").eq("id", body.workspace).maybeSingle();
  if (!ws) return json({ error: "not a member of this workspace" }, 403);

  try {
    if (body.sweep) return json(await sweep(db as unknown as Db, ws.id, 1000));
    if (typeof body.query !== "string" || !body.query.trim()) return json({ error: "query must be text" }, 400);
    const embedding = await embedText(body.query.slice(0, 2000));
    sweepInBackground(db as unknown as Db, ws.id);
    return json({ embedding });
  } catch (err) {
    console.error("embed failed", err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
