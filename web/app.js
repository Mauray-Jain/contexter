// Shared bits for contexter's web pages: the Supabase client and a sign-in panel.
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/+esm";

const cfg = window.CONTEXTER ?? {};
if (!cfg.url || !cfg.key) {
  document.body.innerHTML = '<main class="card"><h1>Not configured</h1><p>config.js is missing the Supabase URL and publishable key.</p></main>';
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

// Resolve with the signed-in user, showing a sign-in panel in `mount` until there is one.
export async function requireSignIn(mount, { title = "Sign in to contexter", note = "" } = {}) {
  const { data } = await sb.auth.getSession();
  if (data.session) return data.session.user;

  return new Promise((resolve) => {
    const status = el("p", { class: "muted", role: "status" });
    const email = el("input", { type: "email", placeholder: "you@example.com", required: true, autocomplete: "email", "aria-label": "Email" });
    const code = el("input", { inputmode: "numeric", pattern: "[0-9]{6}", placeholder: "6-digit code", "aria-label": "Sign-in code", autocomplete: "one-time-code" });
    const codeForm = el("form", { class: "row", hidden: true, onsubmit: async (e) => {
      e.preventDefault();
      status.textContent = "Checking…";
      const { data, error } = await sb.auth.verifyOtp({ email: email.value.trim(), token: code.value.trim(), type: "email" });
      if (error) { status.textContent = error.message; return; }
      resolve(data.user);
    } }, code, el("button", { type: "submit" }, "Sign in"));
    const emailForm = el("form", { class: "row", onsubmit: async (e) => {
      e.preventDefault();
      status.textContent = "Sending a code…";
      const { error } = await sb.auth.signInWithOtp({ email: email.value.trim(), options: { shouldCreateUser: true } });
      if (error) { status.textContent = error.message; return; }
      status.textContent = `We emailed a 6-digit code to ${email.value.trim()}.`;
      codeForm.hidden = false;
      code.focus();
    } }, email, el("button", { type: "submit", class: "secondary" }, "Email me a code"));
    const github = el("button", { type: "button", class: "primary wide", onclick: () =>
      sb.auth.signInWithOAuth({ provider: "github", options: { redirectTo: location.href } }) }, "Continue with GitHub");

    mount.replaceChildren(el("section", { class: "card narrow" },
      el("h1", {}, title), note && el("p", { class: "muted" }, note),
      github, el("div", { class: "divider" }, "or"), emailForm, codeForm, status));
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
