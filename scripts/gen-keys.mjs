// Local-only ES256 signing key for Supabase Auth (needed by the MCP server's token checks).
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const key = JSON.parse(execFileSync("npx", ["supabase", "gen", "signing-key", "--algorithm", "ES256"], { encoding: "utf8" }));
writeFileSync("supabase/signing_keys.json", JSON.stringify(Array.isArray(key) ? key : [key], null, 2), { mode: 0o600 });
console.log("wrote supabase/signing_keys.json");
