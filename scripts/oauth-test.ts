// End-to-end test of the connector sign-in that Claude chat / Claude Code perform:
// discovery → dynamic client registration → PKCE authorize → consent → token → MCP call → refresh.
// With --browser, it prints the authorize URL and waits for a human (or the browser pane) to
// approve on the consent page; otherwise it approves through the same API the page uses.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { localEnv, signIn } from "./lib/local.ts";

const { functions } = localEnv();
const mcp = `${functions}/mcp`;
const browser = process.argv.includes("--browser");
const REDIRECT = "http://127.0.0.1:54546/cb";
const b64url = (b: Buffer) => b.toString("base64url");

const step = (name: string) => console.log(`ok - ${name}`);

// 1. Discovery, as an MCP client does after a 401.
const challenge = (await fetch(mcp, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" }))
  .headers.get("www-authenticate") ?? "";
const prmUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1];
assert.ok(prmUrl, "401 should point at protected resource metadata");
const prm = await (await fetch(prmUrl)).json();
const issuer: string = prm.authorization_servers[0];
const issuerUrl = new URL(issuer);
let as: any;
for (const candidate of [
  `${issuerUrl.origin}/.well-known/oauth-authorization-server${issuerUrl.pathname}`,
  `${issuer}/.well-known/oauth-authorization-server`,
  `${issuerUrl.origin}/.well-known/oauth-authorization-server`,
]) {
  const r = await fetch(candidate);
  if (r.ok) { as = await r.json(); break; }
}
assert.ok(as?.registration_endpoint, "authorization server metadata with a registration endpoint");
assert.ok(as.code_challenge_methods_supported.includes("S256"));
step(`discovery (issuer ${issuer})`);

// 2. Dynamic client registration.
const reg = await (await fetch(as.registration_endpoint, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({
    client_name: "contexter OAuth test", redirect_uris: [REDIRECT], grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"], token_endpoint_auth_method: "none",
  }),
})).json();
assert.ok(reg.client_id, `registration failed: ${JSON.stringify(reg)}`);
step("dynamic client registration");

// 3. Authorize with PKCE: Supabase sends the browser to the app's consent page.
const verifier = b64url(randomBytes(32));
const state = b64url(randomBytes(12));
const authorize = new URL(as.authorization_endpoint);
Object.entries({
  response_type: "code", client_id: reg.client_id, redirect_uri: REDIRECT, state, resource: prm.resource,
  code_challenge: b64url(createHash("sha256").update(verifier).digest()), code_challenge_method: "S256",
}).forEach(([k, v]) => authorize.searchParams.set(k, v));

let code: string;
if (browser) {
  console.log(`\nOpen this URL and approve:\n${authorize}\n`);
  code = await new Promise((resolve) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url!, REDIRECT);
      // Browsers also ask for /favicon.ico; only the callback with our state counts.
      if (u.pathname !== "/cb" || u.searchParams.get("state") !== state) return void res.writeHead(404).end();
      res.end("Approved. You can close this tab.");
      server.close();
      resolve(u.searchParams.get("code")!);
    }).listen(54546, "127.0.0.1");
  });
} else {
  const r = await fetch(authorize, { redirect: "manual" });
  const consent = new URL(r.headers.get("location")!);
  assert.equal(consent.pathname, "/oauth/consent");
  const authorizationId = consent.searchParams.get("authorization_id")!;
  step(`authorize redirects to the consent page (${consent.origin}${consent.pathname})`);

  const user = await signIn(`oauth-${Date.now().toString(36)}@oauth.local`);
  const details = await user.sb.auth.oauth.getAuthorizationDetails(authorizationId);
  assert.equal(details.error, null);
  assert.equal(details.data!.client.name, "contexter OAuth test");
  const approved = await user.sb.auth.oauth.approveAuthorization(authorizationId);
  assert.equal(approved.error, null);
  const back = new URL(approved.data!.redirect_url);
  assert.equal(back.searchParams.get("state"), state);
  code = back.searchParams.get("code")!;
  step("consent approved, code returned to the client's redirect URI");
}

// 4. Token exchange.
const token = await (await fetch(as.token_endpoint, {
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: reg.client_id, code_verifier: verifier }),
})).json();
assert.ok(token.access_token, `token exchange failed: ${JSON.stringify(token)}`);
step("token exchange");

// 5. The issued token works against the MCP server.
const client = new Client({ name: "oauth-test", version: "0" });
await client.connect(new StreamableHTTPClientTransport(new URL(mcp), { requestInit: { headers: { authorization: `Bearer ${token.access_token}` } } }));
const res = await client.callTool({ name: "list_workspaces", arguments: {} });
assert.equal(res.isError ?? false, false, JSON.stringify(res));
step("MCP accepts the OAuth access token");

// 6. Refresh.
const refreshed = await (await fetch(as.token_endpoint, {
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: token.refresh_token, client_id: reg.client_id }),
})).json();
assert.ok(refreshed.access_token, `refresh failed: ${JSON.stringify(refreshed)}`);
step("refresh token");
process.exit(0);
