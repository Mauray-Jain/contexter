// contexter remote MCP server. One endpoint for every client: Claude chat (desktop, web,
// mobile) adds it as a custom connector; Claude Code adds it with `claude mcp add --transport http`.
// Auth is Supabase's OAuth 2.1 server; every query runs as the signed-in user, under RLS.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { pipeline } from "@supabase/middleware";
import { withOAuthProtectedResource, withSupabase } from "@supabase/server";
import { createMcpHandler, McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import * as core from "../_shared/contexter.ts";

const workspace = z.string().optional()
  .describe("Workspace slug. Omit to use your default workspace (see use_workspace).");
const ref = z.string().describe("Unit ref as <collection>/<key>, e.g. sections/method");

type Text = { content: { type: "text"; text: string }[]; isError?: boolean };
const text = (...parts: string[]): Text => ({
  content: parts.filter(Boolean).map((t) => ({ type: "text" as const, text: t })),
});

function buildServer(db: core.Db, userId: string, client: core.Client) {
  const server = new McpServer(
    { name: "contexter", version: "0.2.0" },
    { instructions: core.CHAT_RULES },
  );

  // Every tool runs in the caller's workspace context and ends with the team feed delta, so any
  // call keeps Claude in sync. Claude Code gets its feed from hooks, so it has no chat session.
  async function run(ws: string | undefined, fn: (ctx: core.Ctx) => Promise<string>, opts = { delta: true }): Promise<Text> {
    try {
      const ctx = await core.loadCtx(db, userId, client === "claude-code"
        ? { workspace: ws, session: null }
        : { workspace: ws, client, title: "Claude chat" });
      const result = await fn(ctx);
      const delta = opts.delta ? await core.feedDelta(ctx) : "";
      return text(result, delta);
    } catch (err) {
      return { ...text(err instanceof Error ? err.message : String(err)), isError: true };
    }
  }

  server.registerTool("sync", {
    title: "Sync with the team",
    description: "Call this FIRST in every reply. Returns what teammates (and their Claudes) did since you last " +
      "looked, who is working on what right now, and any messages for this user. Pass user_request so teammates " +
      "see what you're working on and so you're warned if a teammate already asked for or did the same work.",
    inputSchema: z.object({
      workspace,
      user_request: z.string().optional().describe(
        "The user's message in a sentence (verbatim if short). Omit if they started it with !private."),
    }),
  }, async ({ workspace, user_request }) => run(workspace, async (ctx) => {
    const request = user_request?.trim() ?? "";
    if (request) await core.startTask(ctx, request);
    const [here, hint, overlap] = await Promise.all([
      core.presence(ctx), core.compactionHint(ctx), request ? core.overlapWarning(ctx, request) : "",
    ]);
    const delta = await core.feedDelta(ctx);
    return [
      overlap,
      delta || `No new activity in ${ctx.ws.slug} since you last looked.`,
      here.length ? `Right now:\n${here.map((l) => `- ${l}`).join("\n")}` : "",
      hint,
    ].filter(Boolean).join("\n\n");
  }, { delta: false }));

  server.registerTool("resume", {
    title: "Catch up on the workspace",
    description: "Full context for a fresh conversation: workspace overview, the team's shared memory summary and " +
      "everything since. Use at the start of a new chat.",
    inputSchema: z.object({ workspace }),
    annotations: { readOnlyHint: true },
  }, async ({ workspace }) => run(workspace, async (ctx) =>
    [await core.overview(ctx), await core.memoryContext(ctx), await core.compactionHint(ctx)].filter(Boolean).join("\n\n")));

  server.registerTool("post_turn", {
    title: "Share this turn with the team",
    description: "Call at the END of a reply that did real work, so teammates' Claudes see it. Skip if the user " +
      "started their message with !private.",
    inputSchema: z.object({
      workspace,
      user_request: z.string().describe("What the user asked, in a sentence (or verbatim if short)"),
      summary: z.string().describe("One or two sentences: what you did, decided or found"),
    }),
  }, async ({ workspace, user_request, summary }) => run(workspace, async (ctx) => {
    await core.postPrompt(ctx, user_request);
    await core.postReply(ctx, { summary });
    await core.finishTask(ctx);
    return "Shared with the team.";
  }));

  server.registerTool("get_overview", {
    title: "Workspace overview",
    description: "Members, rules, every unit with status/version/owner, open questions and who is active now.",
    inputSchema: z.object({ workspace }),
    annotations: { readOnlyHint: true },
  }, async ({ workspace }) => run(workspace, core.overview));

  server.registerTool("team_feed", {
    title: "Browse the team feed",
    description: "Look back through the feed in detail (does not mark anything as read).",
    inputSchema: z.object({
      workspace,
      limit: z.number().int().min(1).max(200).optional(),
      member: z.string().optional().describe("Only this member's events (handle)"),
      unit: z.string().optional().describe("Only events about this unit ref"),
      before: z.number().int().optional().describe("Only events with id below this, for paging"),
    }),
    annotations: { readOnlyHint: true },
  }, async ({ workspace, ...opts }) => run(workspace, (ctx) => core.teamFeed(ctx, opts)));

  server.registerTool("read_unit", {
    title: "Read a unit",
    description: "Content of a unit (section, chapter, spec…) with its version, lock and linked reasoning.",
    inputSchema: z.object({ workspace, ref, version: z.number().int().min(1).optional() }),
    annotations: { readOnlyHint: true },
  }, async ({ workspace, ref, version }) => run(workspace, (ctx) => core.readUnit(ctx, ref, version)));

  server.registerTool("unit_history", {
    title: "Unit history",
    description: "Every version of a unit with who changed it and why.",
    inputSchema: z.object({ workspace, ref }),
    annotations: { readOnlyHint: true },
  }, async ({ workspace, ref }) => run(workspace, (ctx) => core.unitHistory(ctx, ref)));

  server.registerTool("diff_unit", {
    title: "Diff two versions",
    description: "Line diff of a unit between two versions (to defaults to current).",
    inputSchema: z.object({ workspace, ref, from: z.number().int().min(0), to: z.number().int().min(1).optional() }),
    annotations: { readOnlyHint: true },
  }, async ({ workspace, ref, from, to }) => run(workspace, (ctx) => core.diffUnit(ctx, ref, from, to)));

  server.registerTool("write_unit", {
    title: "Write a unit",
    description: "Replace a unit's content. expected_version must be the version you read; if a teammate wrote " +
      "since, this fails and you must merge. Always give a summary and, for non-trivial changes, the reasoning.",
    inputSchema: z.object({
      workspace, ref,
      content: z.string().describe("The full new content (Markdown)"),
      expected_version: z.number().int().min(0),
      summary: z.string().min(3).describe("What changed, in one line"),
      reasoning: z.string().optional().describe("Why: evidence, alternatives considered, consequences"),
    }),
  }, async ({ workspace, ref, content, expected_version, summary, reasoning }) =>
    run(workspace, (ctx) => core.writeUnit(ctx, ref, content, expected_version, summary, reasoning)));

  server.registerTool("create_unit", {
    title: "Create a unit",
    description: "Add a new unit to a collection, e.g. sections/appendix or notes/interview-3.",
    inputSchema: z.object({
      workspace, ref,
      status: z.string().optional(), position: z.number().int().optional(),
      owner: z.string().optional().describe("Member handle who owns it"),
    }),
  }, async ({ workspace, ref, ...opts }) => run(workspace, (ctx) => core.createUnit(ctx, ref, opts)));

  server.registerTool("set_status", {
    title: "Set unit status",
    description: "Move a unit through its workflow, e.g. drafting → review.",
    inputSchema: z.object({ workspace, ref, status: z.string() }),
  }, async ({ workspace, ref, status }) => run(workspace, (ctx) => core.setStatus(ctx, ref, status)));

  server.registerTool("claim_unit", {
    title: "Claim a unit",
    description: "Lock a unit while you edit it so teammates' Claudes don't write over you. Use force only with a reason.",
    inputSchema: z.object({
      workspace, ref,
      minutes: z.number().int().min(5).max(480).optional(),
      force: z.boolean().optional(), reason: z.string().optional(),
    }),
  }, async ({ workspace, ref, minutes, force, reason }) =>
    run(workspace, (ctx) => core.claimUnit(ctx, ref, minutes, force, reason)));

  server.registerTool("release_unit", {
    title: "Release a unit",
    description: "Release your lock on a unit.",
    inputSchema: z.object({ workspace, ref }),
  }, async ({ workspace, ref }) => run(workspace, (ctx) => core.releaseUnit(ctx, ref)));

  server.registerTool("record", {
    title: "Record reasoning",
    description: "Add to the shared reasoning record: a decision, rationale, rejected alternative, finding or open " +
      "question. Link it to the units (and other records) it's about.",
    inputSchema: z.object({
      workspace,
      type: z.enum(core.RECORD_TYPES),
      title: z.string(),
      body: z.string().describe("Context, reasoning, alternatives, evidence, consequences"),
      links: z.array(z.string()).optional().describe("Unit refs and record refs, e.g. ['sections/method','F-0003']"),
    }),
  }, async ({ workspace, type, title, body, links }) => run(workspace, async (ctx) => {
    const r = await core.addRecord(ctx, type, title, body, links);
    return `Recorded ${r.ref}.`;
  }));

  server.registerTool("update_record", {
    title: "Update a record",
    description: "Change a record's status (e.g. accept a decision, resolve a question) or mark it superseded.",
    inputSchema: z.object({
      workspace,
      record: z.string().describe("Record ref, e.g. D-0007"),
      status: z.string().optional(),
      superseded_by: z.string().optional(),
    }),
  }, async ({ workspace, record, status, superseded_by }) =>
    run(workspace, (ctx) => core.updateRecord(ctx, record, status, superseded_by)));

  server.registerTool("why", {
    title: "Why is this like this?",
    description: "Explain a unit or record from the reasoning and edit history; or search reasoning for a question.",
    inputSchema: z.object({ workspace, target: z.string().describe("A unit ref, a record ref, or a free-text question") }),
    annotations: { readOnlyHint: true },
  }, async ({ workspace, target }) => run(workspace, (ctx) => core.why(ctx, target)));

  server.registerTool("search", {
    title: "Search the workspace",
    description: "Full-text search across units, reasoning records and the feed.",
    inputSchema: z.object({ workspace, query: z.string(), limit: z.number().int().min(1).max(50).optional() }),
    annotations: { readOnlyHint: true },
  }, async ({ workspace, query, limit }) => run(workspace, (ctx) => core.search(ctx, query, limit)));

  server.registerTool("mention", {
    title: "Message a teammate",
    description: "Leave a message for teammates; their Claude raises it first on their next message.",
    inputSchema: z.object({ workspace, to: z.array(z.string()).min(1).describe("Member handles"), text: z.string() }),
  }, async ({ workspace, to, text: msg }) => run(workspace, (ctx) => core.mention(ctx, to, msg)));

  server.registerTool("compact_memory", {
    title: "Update the shared memory",
    description: "Replace the team's running summary when asked to by contexter. The summary must merge the previous " +
      "one with the newer events: decisions, state of each unit, open questions, who is doing what.",
    inputSchema: z.object({ workspace, summary: z.string().min(20), covers_up_to: z.number().int().min(0) }),
  }, async ({ workspace, summary, covers_up_to }) => run(workspace, async (ctx) => {
    const m = await core.compactMemory(ctx, summary, covers_up_to);
    return `Shared memory is now v${m.version}.`;
  }));

  server.registerTool("list_workspaces", {
    title: "List workspaces",
    description: "Workspaces you belong to and your default.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true },
  }, async () => {
    try {
      const { data, error } = await db.from("members").select("handle, role, workspaces(slug, name, template)").eq("user_id", userId);
      if (error) throw error;
      const { data: prof } = await db.from("profiles").select("active_workspace").eq("user_id", userId).maybeSingle();
      // deno-lint-ignore no-explicit-any
      const rows = (data as any[]).map((r) => `- ${r.workspaces.slug}: ${r.workspaces.name} (${r.workspaces.template}) as ${r.handle}, ${r.role}`);
      return text(rows.length ? rows.join("\n") : "No workspaces yet.", prof?.active_workspace ? "" : "No default set; use use_workspace.");
    } catch (err) {
      return { ...text(err instanceof Error ? err.message : String(err)), isError: true };
    }
  });

  server.registerTool("use_workspace", {
    title: "Set default workspace",
    description: "Make a workspace your default for all clients.",
    inputSchema: z.object({ workspace: z.string() }),
  }, async ({ workspace }) => run(workspace, async (ctx) => {
    await core.setActiveWorkspace(db, userId, ctx.ws.id);
    return `Default workspace is now ${ctx.ws.slug}.\n\n${await core.overview(ctx)}`;
  }));

  // ── prompts: one-click actions in the client's menu
  server.registerPrompt("resume", {
    title: "Catch me up",
    description: "Load the workspace, the team summary and everything since.",
  }, () => ({
    messages: [{ role: "user", content: { type: "text", text:
      "Call contexter's resume tool, then give me a short briefing: where things stand, what my teammates did recently, anything addressed to me, and what I could pick up next." } }],
  }));

  server.registerPrompt("checkpoint", {
    title: "Checkpoint this conversation",
    description: "Turn this conversation's reasoning into shared records and post a summary.",
  }, () => ({
    messages: [{ role: "user", content: { type: "text", text:
      "Review this conversation. For each decision, finding, rejected alternative or open question we reached that isn't recorded yet, call contexter's record tool (link the relevant units). Then call post_turn with a summary of the conversation so my teammates see it." } }],
  }));

  server.registerPrompt("review", {
    title: "Review a unit",
    description: "Critically review a unit against the workspace rules and its reasoning.",
    argsSchema: z.object({ ref: z.string().describe("Unit ref, e.g. sections/method") }),
  }, ({ ref }) => ({
    messages: [{ role: "user", content: { type: "text", text:
      `Use contexter to read_unit ${ref} and why ${ref}. Review it against the workspace rules and its recorded reasoning: point out unsupported claims, inconsistencies with other units, and gaps. Record significant findings with the record tool.` } }],
  }));

  server.registerPrompt("onboard", {
    title: "Explain this workspace",
    description: "For a new member: what this is, how it's organised, and how to work in it.",
  }, () => ({
    messages: [{ role: "user", content: { type: "text", text:
      "I'm new to this contexter workspace. Call get_overview and resume, then explain what we're building, how it's organised, who does what, the rules, and how I should work with you here." } }],
  }));

  // ── resources: attachable context
  server.registerResource("overview", "contexter://overview", {
    title: "Workspace overview", description: "Units, members, rules, open questions", mimeType: "text/plain",
  }, async (uri) => {
    const ctx = await core.loadCtx(db, userId, { session: null });
    return { contents: [{ uri: uri.href, mimeType: "text/plain", text: await core.overview(ctx) }] };
  });

  server.registerResource("memory", "contexter://memory", {
    title: "Team memory", description: "Shared summary plus everything since", mimeType: "text/plain",
  }, async (uri) => {
    const ctx = await core.loadCtx(db, userId, { session: null });
    return { contents: [{ uri: uri.href, mimeType: "text/plain", text: await core.memoryContext(ctx) }] };
  });

  server.registerResource("unit", new ResourceTemplate("contexter://unit/{collection}/{key}", {
    list: async () => {
      const ctx = await core.loadCtx(db, userId, { session: null });
      const units = await core.listUnits(ctx);
      return { resources: units.map((u) => ({ uri: `contexter://unit/${core.refOf(u)}`, name: core.refOf(u), mimeType: "text/markdown" })) };
    },
  }), { title: "Unit", description: "A unit's content and reasoning", mimeType: "text/markdown" }, async (uri, vars) => {
    const ctx = await core.loadCtx(db, userId, { session: null });
    return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: await core.readUnit(ctx, `${vars.collection}/${vars.key}`) }] };
  });

  return server;
}

export default {
  fetch: pipeline(
    [withOAuthProtectedResource(), withSupabase({ auth: "user" })],
    async (req, { supabase, userClaims }) => {
      const client = req.headers.get("x-contexter-client") === "claude-code" ? "claude-code" : "claude-chat";
      const handler = createMcpHandler(
        () => buildServer(supabase as unknown as core.Db, userClaims!.id, client),
        { onerror: (error: unknown) => console.error("MCP request failed", error) },
      );
      return handler.fetch(req);
    },
  ),
};
