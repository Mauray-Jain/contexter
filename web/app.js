// Shared bits for contexter's web pages: the Supabase client, the app shell, small UI helpers.
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/+esm";

export const PRODUCT = "contexter"; // the one place the product name lives in the UI

export const cfg = window.CONTEXTER ?? {};
if (!cfg.url || !cfg.key) {
  document.body.innerHTML = '<main class="card narrow"><h1>Not configured</h1><p class="muted">config.js is missing the Supabase URL and publishable key.</p></main>';
  throw new Error("contexter: missing config.js");
}

export const sb = createClient(cfg.url, cfg.key, {
  auth: { flowType: "pkce", persistSession: true, detectSessionInUrl: true },
});

export const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) node.setAttribute(k, v === true ? "" : v);
  }
  node.append(...children.flat().filter((c) => c != null && c !== false));
  return node;
};

// ───────── icons: one stroke, one weight ─────────
const ICONS = {
  feed: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  people: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.4 3.2-5.5 6.5-5.5s5.9 2.1 6.5 5.5"/><path d="M16 4.7a3.5 3.5 0 0 1 0 6.6M18 14.8c1.9.7 3.1 2.5 3.5 5.2"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 7 8.5 6 8.5-6"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20.5 14.5A8.5 8.5 0 1 1 9.5 3.5a7 7 0 0 0 11 11z"/>',
  logout: '<path d="M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3M16 8l4 4-4 4M20 12H9"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  send: '<path d="M21 3 10 14M21 3l-7 18-4-7-7-4z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.5-4M4 4v4h4M4 13a8 8 0 0 0 14.5 4M20 20v-4h-4"/>',
};
export function icon(name) {
  const t = document.createElement("template");
  t.innerHTML = `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] ?? ""}</svg>`;
  return t.content.firstChild;
}

// A friendly empty-state mark: plain geometry, drawn in the accent colour.
export function emptyMark(kind = "people") {
  const t = document.createElement("template");
  const shapes = {
    people: '<circle cx="42" cy="34" r="12" fill="currentColor" opacity=".18"/><circle cx="78" cy="34" r="12" fill="currentColor" opacity=".32"/><rect x="24" y="50" width="36" height="20" rx="10" fill="currentColor" opacity=".18"/><rect x="60" y="50" width="36" height="20" rx="10" fill="currentColor" opacity=".32"/>',
    folder: '<rect x="22" y="22" width="76" height="46" rx="8" fill="currentColor" opacity=".18"/><rect x="22" y="14" width="30" height="16" rx="6" fill="currentColor" opacity=".32"/>',
    mail: '<rect x="20" y="20" width="80" height="48" rx="8" fill="currentColor" opacity=".18"/><path d="m24 28 36 24 36-24" stroke="currentColor" stroke-width="3" fill="none" opacity=".5" stroke-linecap="round" stroke-linejoin="round"/>',
    feed: '<rect x="20" y="16" width="80" height="14" rx="7" fill="currentColor" opacity=".32"/><rect x="20" y="38" width="64" height="14" rx="7" fill="currentColor" opacity=".18"/><rect x="20" y="60" width="72" height="14" rx="7" fill="currentColor" opacity=".18"/>',
  };
  t.innerHTML = `<svg viewBox="0 0 120 80" aria-hidden="true">${shapes[kind] ?? shapes.people}</svg>`;
  return t.content.firstChild;
}

// ───────── theme ─────────
function applyTheme(mode) {
  if (mode) document.documentElement.setAttribute("data-theme", mode);
  else document.documentElement.removeAttribute("data-theme");
}
function currentTheme() {
  return document.documentElement.getAttribute("data-theme")
    ?? "dark";
}
export function toggleTheme() {
  const next = currentTheme() === "dark" ? "light" : "dark";
  applyTheme(next);
  try { localStorage.setItem("contexter-theme", next); } catch { /* private mode: the choice just won't persist */ }
  document.dispatchEvent(new Event("contexter-theme"));
}
try { applyTheme(localStorage.getItem("contexter-theme")); } catch { /* ignore */ }

// ───────── people ─────────
const HUES = [275, 30, 155, 330, 85, 215, 5, 185];
export function avatar(name, size = "") {
  const text = String(name ?? "?");
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const parts = text.split("@")[0].split(/[\s._-]+/).filter(Boolean);
  const initials = ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
  return el("span", { class: `avatar ${size}`.trim(), style: `--h:${HUES[h % HUES.length]}`, "aria-hidden": "true" }, initials);
}

// ───────── command palette (⌘K) ─────────
let pageCommands = [];
export const setCommands = (list) => { pageCommands = list; };
export function transition(fn) {
  if (document.startViewTransition && !matchMedia("(prefers-reduced-motion: reduce)").matches) document.startViewTransition(fn);
  else fn();
}
let paletteEl;
function baseCommands() {
  const base = new URL("./", import.meta.url).pathname;
  const go = (path) => () => { location.href = path; };
  return [
    { label: "Go to Feed", icon: "feed", hint: "G F", run: go(base) },
    { label: "Go to People", icon: "people", hint: "G P", run: go(`${base}team/#people`) },
    { label: "Go to Projects", icon: "folder", run: go(`${base}team/#projects`) },
    { label: "Go to Invitations", icon: "mail", run: go(`${base}team/#invitations`) },
    { label: "Go to Team settings", icon: "settings", run: go(`${base}team/#settings`) },
    { label: "Toggle light / dark", icon: "moon", hint: "T", run: toggleTheme },
    { label: "Sign out", icon: "logout", run: signOut },
  ];
}
export function openPalette() {
  if (!paletteEl) {
    paletteEl = el("dialog", { class: "palette", "aria-label": "Command palette" });
    document.body.append(paletteEl);
  }
  const all = [...pageCommands, ...baseCommands()];
  let shown = all, sel = 0;
  const list = el("ul", { role: "listbox" });
  const input = el("input", { placeholder: "Type a command or search…", "aria-label": "Command", autocomplete: "off", spellcheck: "false" });
  const paint = () => {
    list.replaceChildren(...(shown.length ? shown.map((c, i) => el("li", { role: "option", "aria-selected": i === sel ? "true" : "false",
      onmousemove: () => { if (sel !== i) { sel = i; mark(); } }, onclick: () => choose(c) }, icon(c.icon ?? "feed"), c.label, c.hint ? el("small", { class: "mono" }, c.hint) : null))
      : [el("li", { class: "none" }, "No matching command")]));
  };
  const mark = () => [...list.children].forEach((li, i) => { li.setAttribute("aria-selected", String(i === sel)); if (i === sel) li.scrollIntoView({ block: "nearest" }); });
  const choose = (c) => { paletteEl.close(); c.run(); };
  input.addEventListener("input", () => {
    const q = input.value.toLowerCase().split(/\s+/).filter(Boolean);
    shown = all.filter((c) => q.every((t) => c.label.toLowerCase().includes(t)));
    sel = 0; paint();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); sel = Math.min(shown.length - 1, sel + 1); mark(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); sel = Math.max(0, sel - 1); mark(); }
    else if (e.key === "Enter" && shown[sel]) { e.preventDefault(); choose(shown[sel]); }
  });
  paletteEl.replaceChildren(input, list, el("div", { class: "palette-foot" },
    el("span", {}, el("span", { class: "kbd" }, "↑↓"), " move"), el("span", {}, el("span", { class: "kbd" }, "↵"), " select"), el("span", {}, el("span", { class: "kbd" }, "esc"), " close")));
  paint();
  paletteEl.addEventListener("click", (e) => { if (e.target === paletteEl) paletteEl.close(); });
  if (!paletteEl.open) paletteEl.showModal();
  input.focus();
}
addEventListener("keydown", (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? "");
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openPalette(); }
  else if (e.key === "/" && !typing && !paletteEl?.open) { e.preventDefault(); openPalette(); }
  else if (!typing && !paletteEl?.open && !e.metaKey && !e.ctrlKey && !e.altKey) {
    // Single-key shortcuts, the ones the palette advertises: T theme, I invite, G then F / P to jump.
    const k = e.key.toLowerCase();
    if (goPending) {
      goPending = false;
      const cmd = baseCommands().find((c) => c.hint === `G ${k.toUpperCase()}`);
      if (cmd) { e.preventDefault(); cmd.run(); }
    } else if (k === "g") { goPending = true; setTimeout(() => { goPending = false; }, 900); }
    else if (k === "t") toggleTheme();
    else if (k === "i") pageCommands.find((c) => c.hint === "I")?.run();
  }
});
let goPending = false;

// ───────── app shell ─────────
// One shell for every signed-in page: sidebar navigation, theme toggle, who's signed in.
export function appShell(mount, user, active) {
  const base = new URL("./", import.meta.url).pathname;
  const items = [
    ["feed", "Feed", base, "feed"],
    ["people", "People", `${base}team/#people`, "people"],
    ["projects", "Projects", `${base}team/#projects`, "folder"],
    ["invitations", "Invitations", `${base}team/#invitations`, "mail"],
    ["settings", "Team settings", `${base}team/#settings`, "settings"],
  ];
  const links = new Map(items.map(([key, label, href, ic]) =>
    [key, el("a", { href, "aria-current": key === active ? "page" : null }, icon(ic), label)]));
  const themeBtn = el("button", { type: "button", class: "btn-ghost btn-sm", "aria-label": "Toggle light and dark theme", title: "Light / dark", onclick: () => {
    toggleTheme();
  } }, icon(currentTheme() === "dark" ? "sun" : "moon"));
  document.addEventListener("contexter-theme", () => themeBtn.replaceChildren(icon(currentTheme() === "dark" ? "sun" : "moon")));
  const head = el("div", { class: "page-head" });
  const content = el("div");
  mount.replaceChildren(el("div", { class: "app" },
    el("aside", { class: "sidebar" },
      el("a", { class: "brand", href: base }, el("span", { class: "brand-mark" }, icon("feed")), PRODUCT),
      el("button", { type: "button", class: "jump", onclick: openPalette, "aria-label": "Open the command palette" }, icon("search"), el("span", {}, "Jump to…"), el("span", { class: "kbd" }, "⌘K")),
      el("nav", { class: "nav", "aria-label": "Main" }, [...links.values()]),
      el("span", { class: "spacer" }),
      themeBtn,
      el("div", { class: "me" }, avatar(user.email, "sm"),
        el("div", { class: "who" }, el("b", {}, user.email), el("span", {}, "Signed in")),
        el("button", { type: "button", class: "btn-ghost btn-sm", "aria-label": "Sign out", title: "Sign out", onclick: signOut }, icon("logout")))),
    el("main", { class: "page", id: "main-content" }, el("div", { class: "page-inner" }, head, content))));
  return {
    content,
    setActive(key) { for (const [k, a] of links) k === key ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current"); },
    setHeader({ title, subtitle, actions = [] }) {
      head.replaceChildren(
        el("div", { class: "titles" }, el("h1", {}, title), subtitle ? el("p", {}, subtitle) : null),
        actions.length ? el("div", { class: "actions" }, actions) : null);
      document.title = `${title} · ${PRODUCT}`;
    },
  };
}

// Resolve with the signed-in user, showing a sign-in panel in `mount` until there is one.
export async function requireSignIn(mount, { title = `Sign in to ${PRODUCT}`, note = "" } = {}) {
  const { data } = await sb.auth.getSession();
  if (data.session) return data.session.user;

  return new Promise((resolve) => {
    const status = el("p", { class: "muted", role: "status" });
    const email = el("input", { type: "email", placeholder: "you@company.com", required: true, autocomplete: "email", "aria-label": "Email" });
    const code = el("input", { inputmode: "numeric", pattern: "[0-9]{6}", placeholder: "6-digit code", "aria-label": "Sign-in code", autocomplete: "one-time-code" });
    const codeForm = el("form", { class: "row", hidden: true, onsubmit: async (e) => {
      e.preventDefault();
      status.textContent = "Checking…";
      const { data, error } = await sb.auth.verifyOtp({ email: email.value.trim(), token: code.value.trim(), type: "email" });
      if (error) { status.textContent = error.message; return; }
      resolve(data.user);
    } }, code, el("button", { type: "submit", class: "primary" }, "Sign in"));
    const emailForm = el("form", { class: "row", onsubmit: async (e) => {
      e.preventDefault();
      status.textContent = "Sending a code…";
      const { error } = await sb.auth.signInWithOtp({ email: email.value.trim(), options: { shouldCreateUser: true } });
      if (error) { status.textContent = error.message; return; }
      status.textContent = `We emailed a 6-digit code to ${email.value.trim()}.`;
      codeForm.hidden = false;
      code.focus();
    } }, email, el("button", { type: "submit" }, "Email me a code"));
    const github = el("button", { type: "button", class: "primary wide", style: "margin-bottom:12px", onclick: () =>
      sb.auth.signInWithOAuth({ provider: "github", options: { redirectTo: location.href } }) }, "Continue with GitHub");

    const feed = [
      ["priya", "asked: “tighten the ablation paragraph in method”", "just now"],
      ["priya", "→ their Claude: rewrote it, two sentences shorter", "just now"],
      ["mehul", "edited sections/results (v4→v5)", "2m ago"],
      ["jordan", "recorded D-0003: frame the result as a trade-off", "9m ago"],
      ["sam", "asked: “@priya can you check Table 2?”", "14m ago"],
    ];
    // The headline's pill cycles through phrases; the form sits right under it.
    const words = ["in sync", "on one page", "in the loop", "up to speed"];
    // Every phrase is stacked in one grid cell, so the pill is always as wide as the longest one and never jumps.
    const spans = words.map((w, i) => el("span", { class: i === 0 ? "on" : "" }, w));
    const word = el("span", { class: "pill-text" }, spans);
    let wi = 0;
    const cycle = setInterval(() => {
      if (!word.isConnected) return clearInterval(cycle);
      spans[wi].classList.remove("on");
      wi = (wi + 1) % words.length;
      spans[wi].classList.add("on");
    }, 2600);
    const chip = (cls, who, what) => el("div", { class: `float-chip ${cls}`, "aria-hidden": "true" }, avatar(who, "sm"), el("span", {}, el("b", {}, who), what));
    mount.replaceChildren(el("div", { class: "landing" },
      el("header", { class: "land-top" },
        el("span", { class: "brand", style: "padding:0" }, el("span", { class: "brand-mark" }, icon("feed")), PRODUCT),
        el("button", { type: "button", class: "btn-ghost btn-sm", "aria-label": "Toggle light and dark theme", onclick: toggleTheme }, icon("moon"))),
      el("div", { class: "land-hero" },
        el("h1", {}, "Every Claude on your team,", el("br"), el("span", { class: "pill" }, el("i", { class: "pill-dot" }), word), "."),
        el("p", { class: "lede" }, note || "One shared workspace, a live feed of what everyone asked and changed, and the reasoning behind every decision."),
        el("div", { class: "auth" },
          el("div", { class: "auth-row" }, github),
          el("div", { class: "divider" }, "or use your email"),
          emailForm, codeForm, status)),
      el("div", { class: "window-wrap" },
        chip("c1", "priya", "'s Claude is editing sections/method"),
        chip("c2", "jordan", " joined the project"),
        el("section", { class: "window", "aria-label": "Example of the live feed" },
          el("div", { class: "window-bar" }, el("i"), el("i"), el("i"), el("span", {}, "Web paper · Team feed"), el("span", { class: "live" }, el("i"), "Live")),
          el("div", { class: "window-body" },
            el("ul", {}, feed.map(([who, what, when], i) => el("li", { style: `--i:${i}` }, avatar(who, "sm"), el("span", {}, el("b", {}, who), " ", what), el("span", { class: "when" }, when)))),
            el("div", { class: "window-side" }, el("b", {}, "Active now"),
              ["priya", "mehul"].map((n) => el("div", { class: "cell-person" }, el("span", { class: "avatar-live" }, avatar(n, "sm")), el("span", {}, n))),
              el("small", {}, "Example activity")))))));
  });
}

export async function signOut() {
  await sb.auth.signOut({ scope: "local" });
  location.reload();
}

export function ago(iso) {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

// Call one of contexter's Edge Functions as the signed-in user.
export async function callFunction(name, body) {
  const { data } = await sb.auth.getSession();
  const res = await fetch(`${cfg.url}/functions/v1/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${data.session?.access_token ?? ""}`, apikey: cfg.key },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `request failed (${res.status})`);
  return json;
}

// A command in a box with a copy button.
export function command(text) {
  const btn = el("button", { type: "button", class: "copy btn-ghost", onclick: async () => {
    try { await navigator.clipboard.writeText(text); btn.replaceChildren(icon("check"), "Copied"); }
    catch { btn.textContent = "Select and copy"; }
    setTimeout(() => btn.replaceChildren(icon("copy"), "Copy"), 1500);
  } }, icon("copy"), "Copy");
  return el("div", { class: "cmd" }, el("code", {}, text), btn);
}
