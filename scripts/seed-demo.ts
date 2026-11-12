// Fill the local stack with a demo workspace (three members, edits, reasoning, chat) so the
// dashboard and tools have something to show. Usage: npm run seed -- [your@email]
// The given email (signed in through the local mail viewer) joins as the third member.
import { localEnv, signIn } from "./lib/local.ts";
import * as core from "../supabase/functions/_shared/contexter.ts";

localEnv();
const run = Date.now().toString(36);
const me = process.argv[2];
const slug = `demo-${run}`;

const mauray = await signIn(`mauray-${run}@demo.local`);
const priya = await signIn(`priya-${run}@demo.local`);
const third = await signIn(me ?? `sam-${run}@demo.local`);

const ws = (await mauray.sb.rpc("create_workspace", {
  p_slug: slug, p_name: "Robust retrieval paper", p_handle: "mauray", p_template: "research-paper",
  p_manifest: {
    collections: { sections: { kind: "managed", ordered: true, statuses: ["outline", "drafting", "review", "final"] } },
    rules: ["Use pandoc citations [@key]", "Present tense, first person plural"],
  },
}).single()).data as { id: string };
await mauray.sb.from("units").insert(["abstract", "introduction", "method", "results"].map((key, i) =>
  ({ workspace_id: ws.id, collection: "sections", key, position: i + 1 })));
for (const [who, handle] of [[priya, "priya"], [third, me ? "me" : "sam"]] as const) {
  const code = (await mauray.sb.from("invites").insert({ workspace_id: ws.id }).select("code").single()).data!.code;
  await who.sb.rpc("join_workspace", { p_code: code, p_handle: handle });
}

const ctxM = await core.loadCtx(mauray.sb, mauray.userId, { workspace: slug, client: "claude-code", externalId: `demo-${run}-m` });
const ctxP = await core.loadCtx(priya.sb, priya.userId, { workspace: slug, client: "claude-chat" });

await core.postPrompt(ctxM, "Draft the method section around dense retrieval with a re-ranking stage");
await core.writeUnit(ctxM, "sections/method", "# Method\n\nWe retrieve with a dense bi-encoder and re-rank the top 100 with a cross-encoder [@nogueira2019].",
  0, "First draft of the method", "Dense retrieval beat BM25 by 9 points nDCG@10 on the pilot set.");
await core.postReply(ctxM, { summary: "Drafted the method: dense bi-encoder retrieval, cross-encoder re-ranking of the top 100." });
await core.addRecord(ctxM, "decision", "Drop the BM25 baseline", "It is dominated by the dense-only ablation and costs a page.", ["sections/method"]);
await core.setStatus(ctxM, "sections/method", "review");
await core.postPrompt(ctxP, "Can you check the results table against the new runs? @mauray the re-ranker numbers changed");
await core.addRecord(ctxP, "question", "Do we report latency for the re-ranker?", "Reviewers will ask; we have the numbers but not on the same hardware.", ["sections/results"]);
await core.claimUnit(ctxP, "sections/results", 90);
await core.postReply(ctxP, { summary: "Updated Table 2 with the new re-ranker runs; latency still open (Q-0001)." });

console.log(`Seeded workspace "${slug}"${me ? ` with ${me} as a member ("me")` : ""}.`);
process.exit(0);
