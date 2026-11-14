// Invite people to a team by email. The caller's token authorises everything: invite_to_team()
// runs as them under RLS (only team admins pass), so this function can't be used to invite
// anyone on someone else's behalf. The service role is used only to send the mail.
//
// POST { team, emails[], team_role?, grants?: [{workspace_id, role}] }
//   -> { invited: [{ email, mail: "sent" | "failed", error? }] }
// A failed email leaves the invite pending: it still applies when that person signs in.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type, apikey, x-client-info",
  "access-control-allow-methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const opts = { auth: { persistSession: false, autoRefreshToken: false } };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const authz = req.headers.get("authorization") ?? "";
  const user = createClient(url, anonKey, { ...opts, global: { headers: { Authorization: authz } } });
  const { data: who } = await user.auth.getUser(authz.replace(/^Bearer\s+/i, ""));
  if (!who?.user) return json({ error: "sign in first" }, 401);

  let body: { team?: string; emails?: unknown; team_role?: string; grants?: unknown };
  try { body = await req.json(); } catch { return json({ error: "body must be JSON" }, 400); }
  if (!body.team || !UUID.test(body.team)) return json({ error: "team must be a team id" }, 400);
  if (!Array.isArray(body.emails) || body.emails.some((e) => typeof e !== "string")) {
    return json({ error: "emails must be a list of addresses" }, 400);
  }

  // Authorisation and validation live in the database function, as the caller.
  const { data: rows, error } = await user.rpc("invite_to_team", {
    p_team: body.team,
    p_emails: body.emails,
    p_team_role: body.team_role ?? "member",
    p_grants: body.grants ?? [],
  });
  if (error) {
    const status = error.code === "42501" ? 403 : error.code === "22023" || error.code === "23514" ? 400 : 500;
    return json({ error: error.message }, status);
  }

  const { data: team } = await user.from("teams").select("name").eq("id", body.team).single();
  const inviter = who.user.email ?? "A teammate";
  const joinUrl = `${(Deno.env.get("CONTEXTER_WEB_URL") ?? "http://127.0.0.1:3000").replace(/\/$/, "")}/join`;
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, opts);
  const anon = createClient(url, anonKey, opts);

  const invited = [];
  for (const row of rows as { email: string }[]) {
    // New people get an invite link (it also verifies their email). People who already have an
    // account get a sign-in email that lands on the same page; either way the invite itself is
    // applied from their verified email when they sign in.
    let sent = await admin.auth.admin.inviteUserByEmail(row.email, {
      redirectTo: joinUrl,
      data: { team: team?.name ?? "a team", invited_by: inviter },
    });
    if (sent.error && /already|registered|exists/i.test(sent.error.message + (sent.error.code ?? ""))) {
      sent = await anon.auth.signInWithOtp({
        email: row.email,
        options: { emailRedirectTo: joinUrl, shouldCreateUser: false },
      }) as typeof sent;
    }
    invited.push(sent.error
      ? { email: row.email, mail: "failed", error: sent.error.message }
      : { email: row.email, mail: "sent" });
  }
  return json({ invited });
});
