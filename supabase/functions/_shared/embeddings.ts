// Embeddings for semantic search, computed inside Supabase Edge Functions with the built-in
// gte-small model (384 dims): no API key, nothing leaves the project. Deno/Edge only; the CLI
// reaches this through the `embed` Edge Function.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import type { Db } from "./contexter.ts";

let session: Supabase.ai.Session | undefined;

export async function embedText(text: string): Promise<number[]> {
  session ??= new Supabase.ai.Session("gte-small");
  return await session.run(text, { mean_pool: true, normalize: true }) as number[];
}

// gte-small reads at most 512 tokens, about 2000 characters of English. Split long sources on
// paragraph, then sentence, boundaries into chunks under that, so a long section is searchable
// all the way through rather than only by its opening.
const CHUNK = 1500;
const MAX_CHUNKS = 24;

export function chunkText(text: string): string[] {
  const chunks: string[] = [];
  let current = "";
  const push = () => { if (current.trim()) chunks.push(current.trim()); current = ""; };
  const pieces = text.split(/\n\s*\n/).flatMap((p) =>
    p.length <= CHUNK ? [p] : p.match(/[^.!?]+(?:[.!?]+|$)\s*/g) ?? [p]);
  for (const piece of pieces) {
    for (let i = 0; i < piece.length; i += CHUNK) {
      const part = piece.slice(i, i + CHUNK);
      if (current.length + part.length + 2 > CHUNK) push();
      current += (current ? "\n\n" : "") + part;
    }
  }
  push();
  return chunks.slice(0, MAX_CHUNKS);
}

// Embed what's missing or stale in one workspace until the time budget runs out. Runs as the
// caller: the backlog is read under RLS and store_embeddings() checks membership. Returns how
// many sources were stored and how many were still waiting when it stopped.
export async function sweep(db: Db, workspace: string, budgetMs = 1000) {
  const started = Date.now();
  let embedded = 0;
  let remaining = 0;
  while (Date.now() - started < budgetMs) {
    const { data, error } = await db.rpc("embedding_backlog", { p_workspace: workspace, p_limit: 8 });
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as { source: string; source_id: string; body: string; content_hash: string; remaining: number }[];
    remaining = Number(rows[0]?.remaining ?? 0);
    if (!rows.length) break;
    for (const row of rows) {
      if (Date.now() - started >= budgetMs) break;
      const chunks = [];
      for (const [i, content] of chunkText(row.body).entries()) {
        chunks.push({ chunk: i, content, embedding: await embedText(content) });
      }
      if (!chunks.length) continue;
      const stored = await db.rpc("store_embeddings", {
        p_workspace: workspace, p_source: row.source, p_source_id: row.source_id, p_hash: row.content_hash, p_chunks: chunks,
      });
      if (stored.error) throw new Error(stored.error.message);
      embedded++;
      remaining--;
    }
  }
  return { embedded, remaining: Math.max(remaining, 0) };
}

// Run a sweep after the response is sent, so search and writes never wait for it.
export function sweepInBackground(db: Db, workspace: string, budgetMs = 1000) {
  const work = sweep(db, workspace, budgetMs).catch((err) => console.error("embedding sweep failed:", err));
  try { EdgeRuntime.waitUntil(work); } catch { /* not in the Edge runtime: the promise still runs */ }
}
