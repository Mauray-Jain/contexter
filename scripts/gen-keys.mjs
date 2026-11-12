// Local-only ES256 signing key for Supabase Auth (needed by the MCP server's token checks).
// Runs the CLI outside the project: config.toml points at the keys file, which a fresh
// checkout doesn't have yet, and the CLI refuses to start without it.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const bin = resolve("node_modules/.bin/supabase");
const dir = mkdtempSync(join(tmpdir(), "contexter-keys-"));
try {
  const key = JSON.parse(execFileSync(bin, ["gen", "signing-key", "--algorithm", "ES256"], { cwd: dir, encoding: "utf8" }));
  writeFileSync("supabase/signing_keys.json", JSON.stringify(Array.isArray(key) ? key : [key], null, 2), { mode: 0o600 });
  console.log("wrote supabase/signing_keys.json");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
