// Checkout entry points — `/upgrade`, `/welcome`, `/account`, `/account/export`, `/favicon.ico` routes.
// Vendored identically into every Category-1 product.

import { DodoClient, DodoEnv } from "./dodo";
import { Tier, TIER_LIMITS, extractBearer, resolveKey, monthKey, generateApiKey, KeyRecord } from "./auth";

export interface CheckoutEnv extends DodoEnv {
  USAGE: KVNamespace;
  PRODUCT_NAME?: string;
  PRODUCT_TAGLINE?: string;
  PRODUCT_URL?: string;
}

/**
 * GET /upgrade?tier=solo&email=...&return_to=...
 * → 302 to a Dodo hosted payment link for the selected tier.
 *
 * Generates an unguessable `welcome_token` and threads it through the Dodo
 * subscription metadata + return_url. After payment succeeds, the webhook
 * handler writes KV `welcome:<token>` → <apikey>, and the buyer lands on
 * `/welcome?token=<token>` which shows them their freshly-minted API key.
 */
export async function handleUpgrade(request: Request, env: CheckoutEnv, returnUrlBase: string): Promise<Response> {
  const url = new URL(request.url);
  const tier = (url.searchParams.get("tier") ?? "solo") as Tier;
  if (tier !== "solo" && tier !== "team" && tier !== "pro") {
    return new Response("Invalid tier; one of solo, team, pro", { status: 400 });
  }
  const customer_email = url.searchParams.get("email") ?? undefined;
  const welcomeToken = crypto.randomUUID();
  const return_to = `${returnUrlBase}/welcome?token=${welcomeToken}`;

  const dodo = new DodoClient(env);
  try {
    const link = await dodo.createCheckoutLink({
      tier: tier as "solo" | "team" | "pro",
      customer_email,
      success_url: return_to,
      metadata: { source: "upgrade-link", welcome_token: welcomeToken, tier },
    });
    return Response.redirect(link.payment_link, 302);
  } catch (err) {
    return new Response(`Checkout error: ${err instanceof Error ? err.message : String(err)}`, { status: 502 });
  }
}

/**
 * GET /welcome?token=<welcome_token>
 * → Post-payment success page. Shows the API key + install snippets.
 *
 * The page polls itself via inline JS if the webhook hasn't landed yet
 * (cold-start race), so buyers always end up seeing their key without
 * needing to refresh manually.
 */
export async function handleWelcome(request: Request, env: CheckoutEnv): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (!token) return htmlResponse(welcomeErrorHtml("Missing ?token= in URL. This page is only reachable after a successful payment redirect.", env, url), 400);

  const apiKey = await env.USAGE.get(`welcome:${token}`);
  // JSON probe path: /welcome.json?token=... — used by the page's polling JS.
  if (url.pathname.endsWith(".json")) {
    if (!apiKey) return json({ ready: false });
    const rec = await env.USAGE.get<KeyRecord>(`key:${apiKey}`, "json");
    return json({ ready: true, apiKey, tier: rec?.tier ?? "solo", owner: rec?.owner ?? "", monthlyResetAt: rec?.monthlyResetAt ?? null });
  }
  if (!apiKey) {
    // Webhook hasn't landed yet → show processing page with auto-refresh.
    return htmlResponse(welcomeProcessingHtml(token, env, url), 202);
  }
  const rec = await env.USAGE.get<KeyRecord>(`key:${apiKey}`, "json");
  return htmlResponse(welcomeSuccessHtml(apiKey, rec, env, url), 200);
}

/**
 * GET /account
 *   - With Authorization: Bearer <key> → JSON record + portal link + usage.
 *   - Without → HTML "you need a key" page that explains how to get one.
 *
 * POST /account/rotate
 *   - With Authorization: Bearer <key> → revokes the old key, mints a new one
 *     attached to the same subscription, returns it. Customer can do this
 *     themselves if they suspect a key leak.
 */
export async function handleAccount(request: Request, env: CheckoutEnv): Promise<Response> {
  const apiKey = extractBearer(request);
  if (!apiKey) return json({ error: "Missing Authorization header", hint: "Send Authorization: Bearer <your_mck_key>. If you don't have a key yet, visit /upgrade?tier=solo to subscribe." }, 401);

  const { tier, owner, status } = await resolveKey(apiKey, env.USAGE);
  if (status === "anonymous") return json({ error: "Unknown API key", hint: "This key was either revoked, never minted, or never reached our records. Contact support if you paid and didn't receive a key." }, 404);

  const rec = await env.USAGE.get<KeyRecord>(`key:${apiKey}`, "json");

  // Pull current month's usage counter so customer can see how much quota remains.
  const month = monthKey();
  const calls_this_month = parseInt((await env.USAGE.get(`counter:${apiKey}:${month}`)) || "0", 10);
  const limit = TIER_LIMITS[tier].monthlyCalls;
  const remaining = Math.max(0, limit - calls_this_month);

  let portal_url: string | null = null;
  if (rec?.customerId) {
    try {
      const dodo = new DodoClient(env);
      portal_url = (await dodo.createCustomerPortalLink(rec.customerId)).portal_url || null;
    } catch (err) {
      console.error("portal link failed:", err);
    }
  }
  return json({
    apiKey,
    tier,
    owner,
    status,
    usage: {
      month,
      calls_this_month,
      monthly_limit: limit,
      remaining,
      pct_used: Number(((calls_this_month / limit) * 100).toFixed(1)),
      resets_at: rec?.monthlyResetAt ? new Date(rec.monthlyResetAt).toISOString() : null,
    },
    portal_url,
  });
}

export async function handleAccountRotate(request: Request, env: CheckoutEnv): Promise<Response> {
  const apiKey = extractBearer(request);
  if (!apiKey) return json({ error: "Missing Authorization header" }, 401);
  const rec = await env.USAGE.get<KeyRecord>(`key:${apiKey}`, "json");
  if (!rec) return json({ error: "Unknown API key" }, 404);
  if (rec.status !== "active") return json({ error: "Key is not active; cannot rotate. Status: " + rec.status }, 409);

  // Mint new key with same tier/owner/subscription, revoke old key.
  const newKey = generateApiKey();
  await env.USAGE.put(`key:${newKey}`, JSON.stringify(rec));
  if (rec.subscriptionId) await env.USAGE.put(`sub:${rec.subscriptionId}`, newKey);
  await env.USAGE.delete(`key:${apiKey}`);

  return json({
    new_api_key: newKey,
    note: "Your old key has been revoked. Update your MCP client config immediately. The new key inherits the same tier, status, and monthlyResetAt.",
    tier: rec.tier,
    owner: rec.owner,
  });
}

/**
 * GET /account/export — GDPR "right to data portability" endpoint.
 *
 * Requires Authorization: Bearer <api-key>. Returns a JSON dump of every
 * piece of personal data we hold for the requester:
 *   - account record   (KV `key:<apikey>`)
 *   - subscription info (subscriptionId + last-known status from the key record)
 *   - usage counters    (current day not tracked separately → reuse rate buckets, plus current month)
 *   - webhook events    (KV `event:<apikey>:<eventid>` — last 90 days, written by webhook handler)
 *
 * No data is invented; whatever the existing schema stores is mirrored here.
 */
export async function handleAccountExport(request: Request, env: CheckoutEnv): Promise<Response> {
  const apiKey = extractBearer(request);
  if (!apiKey) {
    return json({ error: "Missing Authorization header", hint: "Send Authorization: Bearer <your_mck_key>." }, 401);
  }

  const rec = await env.USAGE.get<KeyRecord>(`key:${apiKey}`, "json");
  if (!rec) {
    return json({ error: "Unknown API key" }, 404);
  }

  // Usage figures: monthly counter (always tracked) + today's calls (sum of per-minute buckets for today).
  const month = monthKey();
  const monthCalls = parseInt((await env.USAGE.get(`counter:${apiKey}:${month}`)) || "0", 10);
  const tierLimit = TIER_LIMITS[rec.tier].monthlyCalls;

  // Today's calls — sum the 1440 per-minute rate buckets for today. Most will be missing (60s TTL),
  // so this is a best-effort lower bound; we mirror only what KV still holds.
  const todayCalls = await sumTodayCalls(env.USAGE, apiKey);

  // Recent webhook events, last 90 days. Webhook handler writes `event:<apikey>:<ts>:<type>` with
  // a 90-day TTL; if the list is empty (e.g. before event logging was wired up), we return [].
  const events = await listRecentEvents(env.USAGE, apiKey);

  return json({
    exported_at: new Date().toISOString(),
    account: {
      api_key: apiKey,
      email: rec.owner,
      tier: rec.tier,
      status: rec.status,
      created_at: new Date(rec.createdAt).toISOString(),
      monthly_reset_at: new Date(rec.monthlyResetAt).toISOString(),
      customer_id: rec.customerId ?? null,
    },
    subscription: {
      subscription_id: rec.subscriptionId ?? null,
      status: rec.status,
      current_period_end: new Date(rec.monthlyResetAt).toISOString(),
    },
    usage: {
      today: todayCalls,
      month: monthCalls,
      limit: tierLimit,
      month_bucket: month,
    },
    events,
    notes: "This is a machine-readable export of every record we hold tied to your API key. To request deletion, email prakshatechnologies@gmail.com.",
  });
}

async function sumTodayCalls(usage: KVNamespace, apiKey: string): Promise<number> {
  // Per-minute rate buckets carry only a 60-second TTL, so they don't survive long enough
  // to be summed over a full day. Today's calls are therefore derived from the monthly
  // counter delta — but we don't keep yesterday's snapshot, so this is a best-effort
  // estimate: list any remaining `rate:<apikey>:*` buckets that haven't yet expired.
  const list = await usage.list({ prefix: `rate:${apiKey}:`, limit: 1000 });
  let total = 0;
  for (const k of list.keys) {
    const v = await usage.get(k.name);
    if (v) total += parseInt(v, 10) || 0;
  }
  return total;
}

interface StoredEvent {
  type: string;
  at: string;
  data?: Record<string, unknown>;
}

async function listRecentEvents(usage: KVNamespace, apiKey: string): Promise<StoredEvent[]> {
  const list = await usage.list({ prefix: `event:${apiKey}:`, limit: 1000 });
  const events: StoredEvent[] = [];
  for (const k of list.keys) {
    const raw = await usage.get(k.name);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as StoredEvent;
      events.push(parsed);
    } catch {
      // Skip malformed entries rather than failing the whole export.
    }
  }
  // Newest first.
  events.sort((a, b) => (b.at || "").localeCompare(a.at || ""));
  return events;
}

/**
 * GET /favicon.ico — minimalist SVG favicon. Same mark for every product.
 * Served with a 1-week cache so browsers don't re-request on every page.
 */
export function handleFavicon(): Response {
  // Indigo square with white "M" — recognizable across the MCP family.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#4f46e5"/><text x="32" y="44" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,system-ui,sans-serif" font-size="40" font-weight="700" fill="#fff">M</text></svg>`;
  return new Response(svg, {
    status: 200,
    headers: {
      "Content-Type": "image/svg+xml",
      "Cache-Control": "public, max-age=604800, immutable",
    },
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

/** Builds <meta> tags for OG, Twitter card, and description in one block. */
export function buildSocialMeta(env: CheckoutEnv, page: { title: string; description: string; url: string }): string {
  const desc = page.description;
  const productUrl = env.PRODUCT_URL || page.url;
  return [
    `<meta name="description" content="${escapeAttr(desc)}">`,
    `<meta property="og:title" content="${escapeAttr(page.title)}">`,
    `<meta property="og:description" content="${escapeAttr(desc)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:url" content="${escapeAttr(productUrl)}">`,
    `<meta name="twitter:card" content="summary">`,
    `<meta name="twitter:title" content="${escapeAttr(page.title)}">`,
    `<meta name="twitter:description" content="${escapeAttr(desc)}">`,
    `<link rel="icon" type="image/svg+xml" href="/favicon.ico">`,
  ].join("\n");
}

function escapeAttr(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

const PAGE_CSS = `
  body{font:16px/1.55 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;max-width:680px;margin:3rem auto;padding:0 1.2rem;color:#1a1a1a;background:#fafafa}
  h1{font-size:1.8rem;margin:0 0 .5rem;line-height:1.2}
  h2{font-size:1.15rem;margin:2rem 0 .6rem}
  p{margin:.5rem 0 1rem}
  code{background:#eef2f6;padding:.15em .4em;border-radius:4px;font-size:.92em}
  pre{background:#1f2328;color:#e6edf3;padding:1rem;border-radius:8px;overflow-x:auto;font-size:.85rem;line-height:1.5}
  .key{display:flex;align-items:center;background:#fff;border:2px solid #4f46e5;padding:.85em 1em;border-radius:8px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.95rem;word-break:break-all;margin:.5em 0 1em}
  .key code{background:transparent;flex:1;color:#111;font-weight:600}
  .btn{display:inline-block;background:#4f46e5;color:#fff;padding:.5em 1em;border-radius:6px;font-size:.85rem;cursor:pointer;border:0;font-weight:600;text-decoration:none}
  .btn:hover{background:#4338ca}
  .meta{background:#fff;border:1px solid #e1e4e8;padding:1em 1.2em;border-radius:8px;font-size:.95rem}
  .meta dt{font-weight:600;color:#6b7280;font-size:.8rem;text-transform:uppercase;letter-spacing:.04em;margin-top:.5em}
  .meta dd{margin:.2em 0 .6em;font-family:ui-monospace,monospace}
  .spinner{display:inline-block;width:18px;height:18px;border:2px solid #e0e7ff;border-top-color:#4f46e5;border-radius:50%;animation:spin .8s linear infinite;vertical-align:middle;margin-right:.5em}
  @keyframes spin{to{transform:rotate(360deg)}}
  .processing{background:#fff;border:1px solid #fbbf24;padding:1.2em;border-radius:8px;color:#78350f}
  .error{background:#fff;border:1px solid #ef4444;padding:1.2em;border-radius:8px;color:#7f1d1d}
  .footer{margin-top:3rem;padding-top:1.5rem;border-top:1px solid #e5e7eb;font-size:.85rem;color:#6b7280}
`;

function welcomeProcessingHtml(token: string, env: CheckoutEnv, url: URL): string {
  const productName = env.PRODUCT_NAME ?? "your MCP";
  const tagline = env.PRODUCT_TAGLINE ?? "Hosted MCP server for AI agents.";
  const meta = buildSocialMeta(env, {
    title: `Processing your subscription — ${productName}`,
    description: `Finalising your ${productName} subscription. ${tagline}`,
    url: `${url.origin}/welcome`,
  });
  return `<!doctype html><html><head><meta charset="utf-8"><title>Processing — ${productName}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
${meta}
<style>${PAGE_CSS}</style></head><body>
<h1>Payment received</h1>
<div class="processing">
  <p><span class="spinner"></span> <strong>Generating your API key…</strong></p>
  <p>This usually takes 2–5 seconds. This page will auto-refresh when your key is ready.</p>
</div>
<script>
  (async () => {
    const poll = async () => {
      try {
        const r = await fetch("/welcome.json?token=${token}");
        const j = await r.json();
        if (j.ready) { window.location.reload(); return; }
      } catch (e) { /* keep polling */ }
      setTimeout(poll, 2000);
    };
    setTimeout(poll, 1500);
  })();
</script>
<p class="footer">If this page stays here for more than 60 seconds, your payment may have failed or the webhook didn't fire. Check your email for a Dodo Payments receipt, then contact support with your transaction ID.</p>
</body></html>`;
}

function welcomeErrorHtml(message: string, env: CheckoutEnv, url: URL): string {
  const productName = env.PRODUCT_NAME ?? "your MCP";
  const tagline = env.PRODUCT_TAGLINE ?? "Hosted MCP server for AI agents.";
  const meta = buildSocialMeta(env, {
    title: `Error — ${productName}`,
    description: tagline,
    url: `${url.origin}/welcome`,
  });
  return `<!doctype html><html><head><meta charset="utf-8"><title>Error — ${productName}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
${meta}
<style>${PAGE_CSS}</style></head><body>
<h1>Something went wrong</h1>
<div class="error"><p>${escapeHtml(message)}</p></div>
<p><a href="/upgrade?tier=solo" class="btn">Try again</a></p>
</body></html>`;
}

function welcomeSuccessHtml(apiKey: string, rec: KeyRecord | null, env: CheckoutEnv, url: URL): string {
  const productName = env.PRODUCT_NAME ?? "your MCP";
  const tagline = env.PRODUCT_TAGLINE ?? "Hosted MCP server for AI agents.";
  const tier = rec?.tier ?? "solo";
  const owner = rec?.owner ?? "";
  const limits = TIER_LIMITS[tier as Tier] ?? TIER_LIMITS.solo;
  const monthlyLimit = limits.monthlyCalls.toLocaleString();
  const ratePerMin = limits.ratePerMin;
  const meta = buildSocialMeta(env, {
    title: `Welcome to ${productName}`,
    description: tagline,
    url: `${url.origin}/welcome`,
  });

  return `<!doctype html><html><head><meta charset="utf-8"><title>Welcome to ${productName}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
${meta}
<style>${PAGE_CSS}</style></head><body>
<h1>You're in. Welcome to ${productName}.</h1>
<p>Subscription confirmed on the <strong>${tier}</strong> tier${owner ? " for <code>" + escapeHtml(owner) + "</code>" : ""}. Your API key is below — save it now; this page will not be shown again.</p>

<h2>Your API key</h2>
<div class="key">
  <code id="key">${escapeHtml(apiKey)}</code>
  <button class="btn" onclick="navigator.clipboard.writeText(document.getElementById('key').textContent); this.textContent='Copied'">Copy</button>
</div>

<h2>What you get</h2>
<dl class="meta">
  <dt>Tier</dt><dd>${tier}</dd>
  <dt>Monthly call limit</dt><dd>${monthlyLimit} calls</dd>
  <dt>Rate limit</dt><dd>${ratePerMin} calls / minute</dd>
  <dt>Endpoint</dt><dd>https://${slugFromProduct(env.PRODUCT_NAME)}.${cfSubdomain()}.workers.dev/mcp</dd>
</dl>

<h2>Install in Cursor / Claude Desktop / Cline</h2>
<p>Add this to your MCP config (Cursor: <code>~/.cursor/mcp.json</code>, Claude Desktop: <code>claude_desktop_config.json</code>):</p>
<pre><code>{
  "mcpServers": {
    "${slugFromProduct(env.PRODUCT_NAME)}": {
      "url": "https://${slugFromProduct(env.PRODUCT_NAME)}.${cfSubdomain()}.workers.dev/mcp",
      "headers": { "Authorization": "Bearer ${apiKey}" }
    }
  }
}</code></pre>

<h2>Self-service</h2>
<p>
  <a href="/account" class="btn">View account &amp; usage</a>
  <a href="/account/export" class="btn">Export my data (GDPR)</a>
  <a href="${env.UPGRADE_URL}" class="btn">Manage subscription</a>
</p>

<p class="footer">
  Need help? Email <a href="mailto:prakshatechnologies@gmail.com">prakshatechnologies@gmail.com</a>.
  Lost your key? You can rotate it any time with <code>POST /account/rotate</code> (Authorization: Bearer current_key).
  Cancel at any time via the Dodo customer portal — your key keeps working until the end of the billing period.
</p>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function slugFromProduct(name?: string): string {
  return (name || "your-mcp").replace(/[^a-z0-9-]/gi, "");
}

function cfSubdomain(): string {
  // Hardcoded for this deployment; products self-deployed under prakhar-cognizance.
  // If multi-tenant, this should come from an env var.
  return "prakhar-cognizance";
}
