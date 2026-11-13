#!/usr/bin/env node
// Stand-in for the modal CLI in tests. App state lives in the JSON file at $FAKE_MODAL_STATE:
//   { "apps": { "ap-…": { "state": "ephemeral (detached)", "stopped_by": null, "logs": ["…"] } } }
//   modal run [--detach] …          announce $FAKE_MODAL_APP like Modal does, then print epochs until killed
//   modal app info <id> --json      lifecycle state of the app
//   modal app logs <id> --tail N    its last N log lines
// MODAL_PROFILE=missing fails the way Modal does for an unknown profile.
import { readFileSync, writeFileSync } from "node:fs";

const statePath = process.env.FAKE_MODAL_STATE;
const load = () => { try { return JSON.parse(readFileSync(statePath, "utf8")); } catch { return { apps: {} }; } };
const [cmd, sub, id] = process.argv.slice(2);

if (process.env.MODAL_PROFILE === "missing") {
  console.error("╭─ Error ─────────────╮\n│ Token not found      │\n╰─────────────────────╯");
  process.exit(1);
}

if (cmd === "run") {
  const app = process.env.FAKE_MODAL_APP;
  const state = load();
  state.apps[app] = { state: "ephemeral (detached)", stopped_by: null, logs: [] };
  writeFileSync(statePath, JSON.stringify(state));
  console.log(`✓ Initialized. View run at https://modal.com/apps/team/main/${app}`);
  let i = 0;
  setInterval(() => console.log(`epoch ${++i}`), 100);
} else if (cmd === "app" && sub === "info") {
  const app = load().apps[id];
  if (!app) { console.error(`App ${id} not found`); process.exit(1); }
  console.log(JSON.stringify({ app_id: id, lifecycle: { state: app.state, stopped_by: app.stopped_by } }));
} else if (cmd === "app" && sub === "logs") {
  const app = load().apps[id];
  const n = Number(process.argv[process.argv.indexOf("--tail") + 1]) || 100;
  console.log((app?.logs ?? []).slice(-n).join("\n"));
} else {
  console.error(`fake modal: unsupported ${process.argv.slice(2).join(" ")}`);
  process.exit(2);
}
