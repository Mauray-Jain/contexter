// Serve web/ locally at http://127.0.0.1:3000 (the local Auth site_url) with a config.js
// pointing at the local Supabase stack. Hosted deploys write config.js in CI instead.
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

const root = resolve("web");
const env = execFileSync("npx", ["supabase", "status", "-o", "env"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
const get = (k) => new RegExp(`^${k}="(.*)"$`, "m").exec(env)?.[1];
const config = `window.CONTEXTER = ${JSON.stringify({ url: get("API_URL"), key: get("PUBLISHABLE_KEY") })};\n`;
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (path === "/config.js") return res.writeHead(200, { "content-type": "text/javascript" }).end(config);
  const file = normalize(join(root, path));
  if (!file.startsWith(root)) return res.writeHead(403).end();
  // Directories serve their index.html, with or without a trailing slash (Auth redirects to /oauth/consent).
  for (const candidate of [file, join(file, "index.html")]) {
    try {
      const body = await readFile(candidate);
      return res.writeHead(200, { "content-type": types[extname(candidate)] ?? "application/octet-stream" }).end(body);
    } catch {}
  }
  res.writeHead(404).end("not found");
}).listen(3000, "127.0.0.1", () => console.log("contexter web on http://127.0.0.1:3000"));
