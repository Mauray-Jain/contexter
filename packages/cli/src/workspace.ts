// CLI commands that work on workspace content: export, git mirror, live watch.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import * as core from "../../../supabase/functions/_shared/contexter.ts";
import { CliError, getClient, requireUser } from "./client.ts";
import { loadConfig } from "./config.ts";

export async function cliCtx(workspace?: string) {
  const sb = getClient();
  const user = await requireUser(sb);
  return core.loadCtx(sb, user.id, { workspace: workspace ?? loadConfig().activeWorkspace?.slug, session: null });
}

const has = (cmd: string) => spawnSync("which", [cmd], { stdio: "ignore" }).status === 0;

// Bibliography: the first unit whose key or collection says "bib"/"refs", if it has content.
async function bibliography(ctx: core.Ctx): Promise<string | null> {
  const unit = (await core.listUnits(ctx)).find((u) => u.current_version > 0 && (u.collection === "refs" || u.key.includes("bib")));
  if (!unit) return null;
  const { data } = await ctx.db.from("unit_versions").select("content").eq("unit_id", unit.id).eq("version", unit.current_version).single();
  return data?.content?.includes("@") ? data.content : null;
}

export async function exportWorkspace(opts: {
  workspace?: string; collection?: string; withReasoning?: boolean; out?: string; format: string;
}) {
  const ctx = await cliCtx(opts.workspace);
  // The template says which collection is "the document" (sections, chapters, specs…).
  const collection = opts.collection ?? ctx.ws.manifest?.export?.collection ?? (ctx.ws.template === "research-paper" ? "sections" : undefined);
  const md = await core.exportMarkdown(ctx, { collection, withReasoning: opts.withReasoning });
  const out = resolve(opts.out ?? `${ctx.ws.slug}.${opts.format}`);
  if (opts.format === "md") {
    writeFileSync(out, md);
    return out;
  }
  if (!has("pandoc")) throw new CliError("Exporting to anything but md needs pandoc (https://pandoc.org/installing.html)");
  const dir = mkdtempSync(join(tmpdir(), "contexter-export-"));
  try {
    writeFileSync(join(dir, "paper.md"), md);
    const args = [join(dir, "paper.md"), "-o", out, "--standalone"];
    const bib = await bibliography(ctx);
    if (bib) {
      writeFileSync(join(dir, "refs.bib"), bib);
      args.push("--citeproc", `--bibliography=${join(dir, "refs.bib")}`);
    }
    if (opts.format !== "pdf") {
      const r = spawnSync("pandoc", args, { encoding: "utf8" });
      if (r.status !== 0) throw new CliError(`pandoc failed: ${r.stderr.trim()}`);
      return out;
    }
    // Try each installed PDF engine in turn: a half-configured TeX install shouldn't block export.
    const engines = ["typst", "tectonic", "xelatex", "pdflatex", "weasyprint", "wkhtmltopdf"].filter(has);
    if (!engines.length) throw new CliError("PDF export needs a PDF engine (typst, tectonic, xelatex, weasyprint…); try --format html or docx");
    const failures: string[] = [];
    for (const engine of engines) {
      const r = spawnSync("pandoc", [...args, `--pdf-engine=${engine}`], { encoding: "utf8" });
      if (r.status === 0) return out;
      failures.push(`${engine}: ${r.stderr.trim().split("\n").slice(-2).join(" ")}`);
    }
    throw new CliError(`pandoc couldn't make a PDF with any installed engine:\n${failures.join("\n")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

// Read-only backup of the workspace as plain files in a git repo: units, records, memory.
export async function mirror(dir: string, workspace?: string) {
  const ctx = await cliCtx(workspace);
  const root = resolve(dir);
  mkdirSync(root, { recursive: true });
  if (!existsSync(join(root, ".git"))) execFileSync("git", ["init", "-q"], { cwd: root });

  for (const u of await core.listUnits(ctx)) {
    if (!u.current_version) continue;
    const { data } = await ctx.db.from("unit_versions").select("content").eq("unit_id", u.id).eq("version", u.current_version).single();
    const path = join(root, u.collection, `${u.key}.md`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data!.content);
  }
  const { data: records } = await ctx.db.from("records").select("*").eq("workspace_id", ctx.ws.id).order("created_at");
  for (const r of records ?? []) {
    const ref = core.recordRef(r);
    const path = join(root, "records", `${r.type}s`, `${ref}-${slugify(r.title)}.md`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, [
      "---", `id: ${ref}`, `type: ${r.type}`, `status: ${r.status}`, `author: ${ctx.handles.get(r.author_id) ?? r.author_id}`,
      `links: ${JSON.stringify(r.links ?? [])}`, `created: ${r.created_at}`, "---", "", `# ${r.title}`, "", r.body, "",
    ].join("\n"));
  }
  const memory = await core.memoryStatus(ctx);
  if (memory.summary) writeFileSync(join(root, "MEMORY.md"), `# Team memory (v${memory.version})\n\n${memory.summary}\n`);
  writeFileSync(join(root, "OVERVIEW.md"), `${await core.overview(ctx)}\n`);

  execFileSync("git", ["add", "-A"], { cwd: root });
  const dirty = spawnSync("git", ["diff", "--cached", "--quiet"], { cwd: root }).status !== 0;
  if (!dirty) return `${root} is already up to date.`;
  execFileSync("git", ["-c", "user.name=contexter", "-c", "user.email=contexter@localhost",
    "commit", "-q", "-m", `contexter mirror of ${ctx.ws.slug} at ${new Date().toISOString()}`], { cwd: root });
  return `Mirrored ${ctx.ws.slug} into ${root} and committed.`;
}

// Live feed in the terminal (and desktop notifications with --notify) via Supabase Realtime.
export async function watch(opts: { workspace?: string; notify?: boolean }) {
  const ctx = await cliCtx(opts.workspace);
  const sb = getClient();
  const { data } = await sb.auth.getSession();
  sb.realtime.setAuth(data.session!.access_token);
  const notify = opts.notify && has("notify-send");
  sb.channel(`feed-${ctx.ws.id}`)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "events", filter: `workspace_id=eq.${ctx.ws.id}` },
      (msg: { new: core.Event }) => {
        const e = msg.new;
        if (e.author_id === ctx.userId || (e.kind === "presence" && e.payload?.action === "ended")) return;
        const line = core.describeEvent(e, ctx);
        console.log(line);
        if (notify) spawnSync("notify-send", ["contexter", line.replace(/^• /, "")]);
      })
    // SUBSCRIBED only means the channel joined; database changes start flowing seconds later, when
    // Realtime confirms the Postgres subscription. Announce then, so nothing posted after this line is missed.
    .on("system", {}, (msg: { extension?: string; status?: string; message?: string }) => {
      if (msg.extension !== "postgres_changes") return;
      if (msg.status === "ok") console.log(`Watching ${ctx.ws.slug}… (Ctrl-C to stop)`);
      else console.error(`realtime subscription failed: ${msg.message ?? msg.status}`);
    })
    .subscribe((status: string) => {
      if (status === "CHANNEL_ERROR") console.error("realtime connection failed");
    });
  await new Promise(() => {}); // run until interrupted
}
