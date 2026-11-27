// Wire contexter into Claude Code (hooks + skill + MCP server) and package the skill for Claude chat.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CliError } from "./client.ts";
import { loadConfig } from "./config.ts";
import { HOOK_EVENTS, HOOK_MATCHERS } from "./hooks.ts";

const here = dirname(fileURLToPath(import.meta.url));
// Works both from src/ (tsx) and dist/ (bundle): the repo root is three levels up from either.
const repoRoot = resolve(here, "../../..");
const bundle = join(repoRoot, "packages/cli/dist/contexter.mjs");
const skillDir = join(repoRoot, "skill/contexter");
const MARKER = "contexter.mjs\" hook";

export function mcpUrl() {
  const url = loadConfig().url;
  if (!url) throw new CliError("Not configured. Run: contexter setup --url <supabase-url> --key <publishable-key>");
  return `${url.replace(/\/$/, "")}/functions/v1/mcp`;
}

function settingsPath(scope: "user" | "project", cwd: string) {
  return scope === "user" ? join(homedir(), ".claude", "settings.json") : join(cwd, ".claude", "settings.json");
}

function readJson(path: string): Record<string, any> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new CliError(`${path} isn't valid JSON; fix it before installing`);
  }
}

// Remove any contexter hook entries, leaving everything else in settings untouched.
function withoutContexterHooks(settings: Record<string, any>) {
  for (const [event, groups] of Object.entries<any[]>(settings.hooks ?? {})) {
    const kept = groups
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h: any) => !String(h.command ?? "").includes(MARKER)) }))
      .filter((g) => g.hooks.length);
    if (kept.length) settings.hooks[event] = kept;
    else delete settings.hooks[event];
  }
  if (settings.hooks && !Object.keys(settings.hooks).length) delete settings.hooks;
  return settings;
}

const MCP_NAME = "contexter";

function writeJson(path: string, value: Record<string, any>) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

// Claude Code only loads a .mcp.json server once it's approved, and the desktop Code tab never asks,
// so approve it in the folder's personal (git-ignored) settings.local.json.
function addProjectMcp(cwd: string) {
  const mcpPath = join(cwd, ".mcp.json");
  const mcp = readJson(mcpPath);
  mcp.mcpServers ??= {};
  mcp.mcpServers[MCP_NAME] = { type: "http", url: mcpUrl(), headers: { "x-contexter-client": "claude-code" } };
  writeJson(mcpPath, mcp);

  const localPath = join(cwd, ".claude", "settings.local.json");
  const local = readJson(localPath);
  local.enabledMcpjsonServers = [...new Set([...(local.enabledMcpjsonServers ?? []), MCP_NAME])];
  local.disabledMcpjsonServers = (local.disabledMcpjsonServers ?? []).filter((n: string) => n !== MCP_NAME);
  if (!local.disabledMcpjsonServers.length) delete local.disabledMcpjsonServers;
  writeJson(localPath, local);
  return [`MCP server added to ${mcpPath}`, `MCP server approved in ${localPath}`];
}

function removeProjectMcp(cwd: string) {
  const mcpPath = join(cwd, ".mcp.json");
  if (existsSync(mcpPath)) {
    const mcp = readJson(mcpPath);
    if (mcp.mcpServers) delete mcp.mcpServers[MCP_NAME];
    if (mcp.mcpServers && !Object.keys(mcp.mcpServers).length) rmSync(mcpPath);
    else writeJson(mcpPath, mcp);
  }
  const localPath = join(cwd, ".claude", "settings.local.json");
  if (existsSync(localPath)) {
    const local = readJson(localPath);
    if (local.enabledMcpjsonServers) {
      local.enabledMcpjsonServers = local.enabledMcpjsonServers.filter((n: string) => n !== MCP_NAME);
      if (!local.enabledMcpjsonServers.length) delete local.enabledMcpjsonServers;
    }
    writeJson(localPath, local);
  }
}

export function installCode(opts: { scope: "user" | "project"; workspace?: string; cwd: string }) {
  if (!existsSync(bundle)) throw new CliError(`Build the CLI first: npm run build (missing ${bundle})`);
  const path = settingsPath(opts.scope, opts.cwd);
  const settings = withoutContexterHooks(readJson(path));
  settings.hooks ??= {};
  // CONTEXTER_HOME is pinned so hooks use this machine's sign-in even if Claude Code's env differs.
  const envPrefix = process.env.CONTEXTER_HOME ? `CONTEXTER_HOME="${process.env.CONTEXTER_HOME}" ` : "";
  for (const [event, name] of Object.entries(HOOK_EVENTS)) {
    const matcher = HOOK_MATCHERS[event as keyof typeof HOOK_EVENTS];
    settings.hooks[event] ??= [];
    settings.hooks[event].push({
      ...(matcher ? { matcher } : {}),
      hooks: [{ type: "command", command: `${envPrefix}"${process.execPath}" "${bundle}" hook ${name}`, timeout: 20 }],
    });
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);

  const skillsRoot = opts.scope === "user" ? join(homedir(), ".claude", "skills") : join(opts.cwd, ".claude", "skills");
  rmSync(join(skillsRoot, "contexter"), { recursive: true, force: true });
  mkdirSync(skillsRoot, { recursive: true });
  cpSync(skillDir, join(skillsRoot, "contexter"), { recursive: true });

  const done = [`Hooks added to ${path}`, `Skill installed to ${join(skillsRoot, "contexter")}`];
  if (opts.workspace) {
    writeFileSync(join(opts.cwd, ".contexter.json"), `${JSON.stringify({ workspace: opts.workspace }, null, 2)}\n`);
    done.push(`This folder is linked to workspace "${opts.workspace}" (.contexter.json)`);
  } else {
    done.push("Sessions only join a workspace in a linked project folder: run `contexter link <slug>` in each one.");
  }
  if (opts.scope === "project") {
    return [
      ...done,
      ...addProjectMcp(opts.cwd),
      "",
      "Start a new Claude Code session here; contexter signs you in through the browser on first use.",
    ].join("\n");
  }
  // User-scope servers live in ~/.claude.json, which Claude Code rewrites while running, so leave it to the CLI.
  return [
    ...done,
    "",
    "Last step: add the contexter MCP server to Claude Code (it signs you in through the browser on first use):",
    "",
    `  claude mcp add --transport http --scope user ${MCP_NAME} ${mcpUrl()} --header "x-contexter-client: claude-code"`,
  ].join("\n");
}

export function uninstallCode(opts: { scope: "user" | "project"; cwd: string }) {
  const path = settingsPath(opts.scope, opts.cwd);
  if (existsSync(path)) writeFileSync(path, `${JSON.stringify(withoutContexterHooks(readJson(path)), null, 2)}\n`);
  const skillsRoot = opts.scope === "user" ? join(homedir(), ".claude", "skills") : join(opts.cwd, ".claude", "skills");
  rmSync(join(skillsRoot, "contexter"), { recursive: true, force: true });
  if (opts.scope === "project") {
    removeProjectMcp(opts.cwd);
    return `Removed contexter hooks from ${path}, the contexter skill and the contexter MCP server.`;
  }
  return `Removed contexter hooks from ${path} and the contexter skill.`;
}

// A zip of the skill folder, for Settings → Capabilities → Skills in Claude chat.
export function packageSkill(out: string) {
  const target = resolve(out);
  rmSync(target, { force: true });
  const staging = join(tmpdir(), `contexter-skill-${process.pid}`);
  rmSync(staging, { recursive: true, force: true });
  cpSync(skillDir, join(staging, "contexter"), { recursive: true });
  try {
    execFileSync("zip", ["-qr", target, "contexter"], { cwd: staging });
  } catch {
    throw new CliError("Packaging needs the `zip` command");
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return target;
}

export function chatInstructions(zip: string) {
  return [
    `Skill packaged: ${zip}`,
    "",
    "In Claude (desktop, web or mobile):",
    `1. Settings → Connectors → Add custom connector → URL: ${mcpUrl()}`,
    "   Sign in when asked and approve access on the contexter consent page.",
    "2. Settings → Capabilities → Skills → Upload skill → choose the zip above.",
    "3. Optional: in a Project, add the instruction \"This project is contexter workspace <slug>.\"",
    "",
    "Then start any chat with \"catch me up\" (or pick the contexter › resume prompt).",
  ].join("\n");
}
