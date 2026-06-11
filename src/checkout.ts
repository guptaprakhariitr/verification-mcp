// Checkout entry points — `/upgrade`, `/welcome`, `/account`, `/account/export`, `/favicon.ico` routes.
// Vendored identically into every Category-1 product.

import { DodoClient, DodoEnv } from "./dodo";
import { Tier, TIER_LIMITS, TEAM_SEAT_LIMITS, extractBearer, resolveKey, monthKey, generateApiKey, KeyRecord, TeamRecord, TeamMemberRecord } from "./auth";
import { EmailEnv, sendWelcomeEmail, sendSupportTicketForward } from "./email";

export interface CheckoutEnv extends DodoEnv, EmailEnv {
  USAGE: KVNamespace;
  PRODUCT_NAME?: string;
  PRODUCT_TAGLINE?: string;
  PRODUCT_URL?: string;
  // Optional per-product price overrides for the JSON-LD SoftwareApplication
  // schema injected into every landing page. Defaults to $9 / $29 / $79 if
  // unset — products with custom bands (unit-converter, verification,
  // drug-interaction) set these in wrangler.toml.
  PRICE_SOLO?: string;
  PRICE_TEAM?: string;
  PRICE_PRO?: string;
  // Transactional email (Brevo).
  BREVO_API_KEY?: string;
  FROM_EMAIL?: string;
  SUPPORT_FORWARD_EMAIL?: string;
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
  if (tier !== "free" && tier !== "solo" && tier !== "team" && tier !== "pro") {
    return new Response("Invalid tier; one of free, solo, team, pro", { status: 400 });
  }
  const customer_email = url.searchParams.get("email") ?? undefined;

  // Free-tier explicit signup: skip Dodo entirely. Mint a free-tier key in KV
  // and redirect to /welcome with a fresh token. Useful as a lead-capture
  // channel for the free tier and as a stable "API key" path even for
  // non-paying users (so /account works without anonymity surprises).
  if (tier === "free") {
    if (!customer_email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer_email)) {
      return new Response("Free tier signup requires a valid ?email=", { status: 400 });
    }
    const apiKey = generateApiKey();
    const now = Date.now();
    const rec: KeyRecord = {
      tier: "free",
      owner: customer_email,
      createdAt: now,
      monthlyResetAt: startOfNextMonthMs(now),
      status: "active",
    };
    await env.USAGE.put(`key:${apiKey}`, JSON.stringify(rec));
    const welcomeToken = crypto.randomUUID();
    await env.USAGE.put(`welcome:${welcomeToken}`, apiKey, { expirationTtl: 60 * 60 * 24 });
    // Free-tier welcome email. Silently no-ops if Brevo isn't configured.
    await sendWelcomeEmail(env, {
      to: customer_email,
      apiKey,
      tier: "free",
      productName: env.PRODUCT_NAME ?? "your MCP",
      productUrl: env.PRODUCT_URL,
    });
    return Response.redirect(`${returnUrlBase}/welcome?token=${welcomeToken}`, 302);
  }

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

  const resolved = await resolveKey(apiKey, env.USAGE);
  const { tier, owner, status, effectiveKey, is_team_member, member_id } = resolved;
  if (status === "anonymous") return json({ error: "Unknown API key", hint: "This key was either revoked, never minted, or never reached our records. Contact support if you paid and didn't receive a key." }, 404);

  // For a team-member sub-key, all quota counters live under the OWNER's key.
  const billingKey = effectiveKey ?? apiKey;
  const rec = await env.USAGE.get<KeyRecord>(`key:${billingKey}`, "json");

  // Pull current month's usage counter so customer can see how much quota remains.
  const month = monthKey();
  const calls_this_month = parseInt((await env.USAGE.get(`counter:${billingKey}:${month}`)) || "0", 10);
  const limit = TIER_LIMITS[tier].monthlyCalls;
  const remaining = Math.max(0, limit - calls_this_month);

  // Only the owner gets a portal link — sub-keys can't manage the subscription.
  let portal_url: string | null = null;
  if (!is_team_member && rec?.customerId) {
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
    is_team_member: is_team_member ?? false,
    member_id: member_id ?? null,
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

  // Team members (if any). Sub-key VALUES are hashed in the export — the full
  // secret is only ever shown once at invite time. This is a "right to know
  // what you've issued" record, not a credential dump.
  const teamMembers = await listTeamMembersForExport(env.USAGE, apiKey);

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
    team_members: teamMembers,
    events,
    notes: "This is a machine-readable export of every record we hold tied to your API key. To request deletion, email prakshatechnologies@gmail.com.",
  });
}

/**
 * DELETE /account  OR  POST /account/delete  — GDPR right-to-erasure endpoint.
 *
 * Requires Authorization: Bearer <owner-api-key>. For POST, the body must be
 * `{ "confirm": "delete-my-account" }` — a magic string to make accidental
 * deletion (curl, browser autofill, etc.) impossible. The DELETE variant skips
 * the body check because RFC-7231 DELETE bodies are unreliable; the verb
 * itself is the confirmation.
 *
 * Removes:
 *   - key:<api-key>                    — account record
 *   - counter:<api-key>:*              — monthly usage counters (all months)
 *   - rate:<api-key>:*                 — per-minute rate buckets (mostly expired anyway)
 *   - event:<api-key>:*                — webhook event log (last 90 days)
 *   - sub:<subscription-id>            — reverse-lookup from subscription
 *   - team:<api-key>                   — sidecar team-member list
 *   - team-member:<sub-key>            — every sub-key this owner issued
 *   - welcome:<token>                  — not deleted; those keys are short-lived and self-expire
 *
 * Does NOT cancel the Dodo subscription. Dodo billing is a separate system;
 * the user must visit the customer portal (link returned in the response).
 *
 * Sub-keys (team members) cannot self-erase via this endpoint — only the
 * owner of a subscription can erase. A team member who wants their data
 * removed must ask the owner, or the owner can revoke just their sub-key via
 * POST /account/team/revoke.
 */
export async function handleAccountDelete(request: Request, env: CheckoutEnv): Promise<Response> {
  const apiKey = extractBearer(request);
  if (!apiKey) {
    return json({ error: "Missing Authorization header", hint: "Send Authorization: Bearer <your_mck_key>." }, 401);
  }

  // POST variant requires explicit confirmation. DELETE variant is self-confirming via the verb.
  if (request.method === "POST") {
    let body: { confirm?: unknown };
    try { body = (await request.json()) as { confirm?: unknown }; }
    catch { return json({ error: "Invalid JSON body", hint: "Send {\"confirm\":\"delete-my-account\"}." }, 400); }
    if (body.confirm !== "delete-my-account") {
      return json({ error: "Confirmation required", hint: "Body must be {\"confirm\":\"delete-my-account\"} to proceed." }, 400);
    }
  }

  const rec = await env.USAGE.get<KeyRecord>(`key:${apiKey}`, "json");
  if (!rec) {
    // Either unknown, or this is a team-member sub-key (which can't self-delete).
    const member = await env.USAGE.get<TeamMemberRecord>(`team-member:${apiKey}`, "json");
    if (member) {
      return json({
        error: "Team-member sub-keys cannot self-erase",
        hint: "Ask your team owner to revoke this sub-key via POST /account/team/revoke, or to delete their account.",
      }, 403);
    }
    return json({ error: "Unknown API key" }, 404);
  }

  let deletedCount = 0;

  // 1) Counters, rates, events: list-and-delete by prefix.
  for (const prefix of [`counter:${apiKey}:`, `rate:${apiKey}:`, `event:${apiKey}:`]) {
    deletedCount += await deleteByPrefix(env.USAGE, prefix);
  }

  // 2) Team members this owner issued (sub-keys + the sidecar list).
  const team = await env.USAGE.get<TeamRecord>(`team:${apiKey}`, "json");
  if (team) {
    for (const subKey of team.member_ids) {
      await env.USAGE.delete(`team-member:${subKey}`);
      deletedCount++;
    }
    await env.USAGE.delete(`team:${apiKey}`);
    deletedCount++;
  }

  // 3) Subscription reverse-lookup.
  if (rec.subscriptionId) {
    await env.USAGE.delete(`sub:${rec.subscriptionId}`);
    deletedCount++;
  }

  // 4) The account record itself — last, so the above cleanup can't orphan KV
  // entries if something throws mid-way.
  await env.USAGE.delete(`key:${apiKey}`);
  deletedCount++;

  const accountIdHash = await sha256Hex16(apiKey);
  const portalUrl = env.UPGRADE_URL ? env.UPGRADE_URL.replace(/\/upgrade.*$/, "/account") : null;

  return json({
    deleted: true,
    account_id: accountIdHash,
    keys_deleted_count: deletedCount,
    message: "Account deleted. To cancel ongoing billing you must ALSO cancel your subscription in the Dodo customer portal — this endpoint only erases our records; it does not stop charges.",
    dodo_portal_hint: portalUrl ? `Before this deletion, visit ${portalUrl} or your Dodo customer portal email link to cancel the subscription.` : "Cancel your subscription via the Dodo customer portal link in your last receipt email.",
  });
}

async function deleteByPrefix(usage: KVNamespace, prefix: string): Promise<number> {
  let deleted = 0;
  // KV list pagination — keep going until no cursor returned. Per-prefix
  // upper bound here is small (≤ a few hundred), so a single page is the
  // common case but we loop for safety.
  let cursor: string | undefined;
  for (;;) {
    const page = await usage.list({ prefix, limit: 1000, cursor });
    for (const k of page.keys) {
      await usage.delete(k.name);
      deleted++;
    }
    if (page.list_complete || !page.cursor) break;
    cursor = page.cursor;
  }
  return deleted;
}

/**
 * GET /support — HTML contact form. POSTs to /support; server-side handler
 * stores the message in KV under `support:<uuid>` with 90-day TTL.
 *
 * No email is sent. Operators read pending tickets via:
 *   wrangler kv key list --binding USAGE --prefix "support:"
 *   wrangler kv key get  --binding USAGE "support:<uuid>"
 *
 * If we add an admin UI later, this is the read source of truth.
 */
export function handleSupportPage(_request: Request, env: CheckoutEnv): Response {
  const productName = env.PRODUCT_NAME ?? "your MCP";
  const tagline = env.PRODUCT_TAGLINE ?? "Hosted MCP server for AI agents.";
  const productUrl = env.PRODUCT_URL || "";
  const slug = slugFromProduct(env.PRODUCT_NAME);
  const meta = buildSocialMeta(env, {
    title: `Support — ${productName}`,
    description: `Contact support for ${productName}. ${tagline}`,
    url: `${productUrl}/support`,
  });
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Support — ${escapeHtml(productName)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
${meta}
<style>${PAGE_CSS}
  .form-group{margin:1em 0}
  label{display:block;font-weight:600;font-size:.9rem;margin-bottom:.3em;color:#374151}
  input[type=text],input[type=email],textarea{width:100%;padding:.6em .75em;border:1px solid #d1d5db;border-radius:6px;font:inherit;background:#fff;box-sizing:border-box}
  textarea{min-height:140px;resize:vertical;font-family:inherit}
  input:focus,textarea:focus{outline:none;border-color:#4f46e5;box-shadow:0 0 0 3px rgba(79,70,229,.15)}
</style></head><body>
<h1>Support</h1>
<p>Question, bug, or feature request for <strong>${escapeHtml(productName)}</strong>? Drop a message — replies go out from <code>prakshatechnologies@gmail.com</code> within 2 business days.</p>
<form method="POST" action="/support">
  <div class="form-group"><label for="name">Your name</label><input type="text" id="name" name="name" required maxlength="120"></div>
  <div class="form-group"><label for="email">Your email</label><input type="email" id="email" name="email" required maxlength="200"></div>
  <div class="form-group"><label for="subject">Subject</label><input type="text" id="subject" name="subject" required maxlength="200"></div>
  <div class="form-group"><label for="message">Message</label><textarea id="message" name="message" required maxlength="5000"></textarea></div>
  <button type="submit" class="btn">Send message</button>
</form>

<h2>Issue tracking</h2>
<p>Bug reports go to the product's GitHub repo at <a href="https://github.com/guptaprakhariitr/${escapeHtml(slug)}">github.com/guptaprakhariitr/${escapeHtml(slug)}</a>. For account, billing, or data-export requests, use this form.</p>

<h2>Response time</h2>
<p>We aim to acknowledge within 48 hours and resolve within 7 business days. For urgent security or GDPR requests, email <a href="mailto:prakshatechnologies@gmail.com">prakshatechnologies@gmail.com</a> directly.</p>

<p class="footer">Prefer email? Write to <a href="mailto:prakshatechnologies@gmail.com">prakshatechnologies@gmail.com</a>. For account access, see <a href="/account">/account</a>; for data export, <a href="/account/export">/account/export</a>.</p>
</body></html>`;
  return htmlResponse(html, 200);
}

/**
 * POST /support — accepts form-urlencoded OR JSON body
 * `{ name, email, subject, message }`. Writes `support:<uuid>` in KV with 90-day TTL.
 * Returns JSON when Accept: application/json, else an HTML thank-you page.
 */
export async function handleSupportSubmit(request: Request, env: CheckoutEnv): Promise<Response> {
  const wantsJson = (request.headers.get("Accept") || "").includes("application/json");

  let name = "", email = "", subject = "", message = "";
  const ct = (request.headers.get("Content-Type") || "").toLowerCase();
  try {
    if (ct.includes("application/json")) {
      const body = (await request.json()) as Record<string, unknown>;
      name = typeof body.name === "string" ? body.name : "";
      email = typeof body.email === "string" ? body.email : "";
      subject = typeof body.subject === "string" ? body.subject : "";
      message = typeof body.message === "string" ? body.message : "";
    } else {
      // Form-urlencoded or multipart.
      const form = await request.formData();
      name = String(form.get("name") || "");
      email = String(form.get("email") || "");
      subject = String(form.get("subject") || "");
      message = String(form.get("message") || "");
    }
  } catch {
    return wantsJson
      ? json({ error: "Invalid request body" }, 400)
      : htmlResponse(supportErrorHtml("Couldn't parse your submission. Please try again.", env), 400);
  }

  name = name.trim().slice(0, 120);
  email = email.trim().toLowerCase().slice(0, 200);
  subject = subject.trim().slice(0, 200);
  message = message.trim().slice(0, 5000);

  if (!name || !email || !subject || !message) {
    return wantsJson
      ? json({ error: "Missing field(s): name, email, subject, message are all required." }, 400)
      : htmlResponse(supportErrorHtml("All four fields (name, email, subject, message) are required.", env), 400);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return wantsJson
      ? json({ error: "Invalid email address" }, 400)
      : htmlResponse(supportErrorHtml("That doesn't look like a valid email address.", env), 400);
  }

  const ticketId = crypto.randomUUID();
  const record = {
    ticket_id: ticketId,
    name,
    email,
    subject,
    message,
    product_slug: env.PRODUCT_NAME ?? "unknown",
    user_ip: request.headers.get("cf-connecting-ip") || null,
    user_agent: request.headers.get("user-agent") || null,
    created_at: new Date().toISOString(),
  };
  // 90-day TTL — matches our event/audit log window.
  await env.USAGE.put(`support:${ticketId}`, JSON.stringify(record), { expirationTtl: 60 * 60 * 24 * 90 });

  // Forward to operator inbox. Best-effort; never block the user response.
  await sendSupportTicketForward(env, {
    ticketId,
    userName: name,
    userEmail: email,
    userSubject: subject,
    userMessage: message,
    productName: env.PRODUCT_NAME ?? "your MCP",
    productUrl: env.PRODUCT_URL,
  });

  if (wantsJson) {
    return json({ ok: true, ticket_id: ticketId, message: "Thanks — we'll reply via email within 2 business days." }, 201);
  }
  return htmlResponse(supportThanksHtml(ticketId, env), 200);
}

function supportThanksHtml(ticketId: string, env: CheckoutEnv): string {
  const productName = env.PRODUCT_NAME ?? "your MCP";
  const tagline = env.PRODUCT_TAGLINE ?? "Hosted MCP server for AI agents.";
  const productUrl = env.PRODUCT_URL || "";
  const meta = buildSocialMeta(env, {
    title: `Thanks — ${productName}`,
    description: `Support request received for ${productName}. ${tagline}`,
    url: `${productUrl}/support`,
  });
  return `<!doctype html><html><head><meta charset="utf-8"><title>Thanks — ${escapeHtml(productName)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
${meta}
<style>${PAGE_CSS}</style></head><body>
<h1>Thanks — message received.</h1>
<p>We'll reply via email within 2 business days. Your ticket reference:</p>
<div class="key"><code>${escapeHtml(ticketId)}</code></div>
<p>Quote that reference if you follow up by email at <a href="mailto:prakshatechnologies@gmail.com">prakshatechnologies@gmail.com</a>.</p>
<p><a href="/" class="btn">Back to ${escapeHtml(productName)}</a></p>
</body></html>`;
}

function supportErrorHtml(message: string, env: CheckoutEnv): string {
  const productName = env.PRODUCT_NAME ?? "your MCP";
  const tagline = env.PRODUCT_TAGLINE ?? "Hosted MCP server for AI agents.";
  const productUrl = env.PRODUCT_URL || "";
  const meta = buildSocialMeta(env, {
    title: `Support error — ${productName}`,
    description: tagline,
    url: `${productUrl}/support`,
  });
  return `<!doctype html><html><head><meta charset="utf-8"><title>Support error — ${escapeHtml(productName)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
${meta}
<style>${PAGE_CSS}</style></head><body>
<h1>Couldn't submit your message</h1>
<div class="error"><p>${escapeHtml(message)}</p></div>
<p><a href="/support" class="btn">Try again</a></p>
</body></html>`;
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
    buildJsonLd(env, productUrl),
  ].join("\n");
}

/**
 * SoftwareApplication JSON-LD for SEO / AI discovery (Google rich-results,
 * Bing, Perplexity, ChatGPT search). Embedded into every landing page via
 * `buildSocialMeta`. Prices default to the canonical $9/$29/$79 band; products
 * with custom pricing override via PRICE_SOLO / PRICE_TEAM / PRICE_PRO env
 * vars in wrangler.toml.
 */
export function buildJsonLd(env: CheckoutEnv, productUrl: string): string {
  const name = env.PRODUCT_NAME || "MCP server";
  const tagline = env.PRODUCT_TAGLINE || "Hosted MCP server for AI agents.";
  const priceSolo = env.PRICE_SOLO || "9";
  const priceTeam = env.PRICE_TEAM || "29";
  const pricePro = env.PRICE_PRO || "79";
  const schema = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name,
    applicationCategory: "DeveloperApplication",
    operatingSystem: "Cross-platform (Cloudflare Workers, MCP)",
    description: tagline,
    url: productUrl,
    offers: [
      { "@type": "Offer", name: "Free", price: "0", priceCurrency: "USD" },
      { "@type": "Offer", name: "Solo", price: priceSolo, priceCurrency: "USD", priceSpecification: { "@type": "UnitPriceSpecification", billingDuration: "P1M" } },
      { "@type": "Offer", name: "Team", price: priceTeam, priceCurrency: "USD", priceSpecification: { "@type": "UnitPriceSpecification", billingDuration: "P1M" } },
      { "@type": "Offer", name: "Pro", price: pricePro, priceCurrency: "USD", priceSpecification: { "@type": "UnitPriceSpecification", billingDuration: "P1M" } },
    ],
    author: {
      "@type": "Person",
      name: "Prakhar Gupta",
      email: "prakshatechnologies@gmail.com",
      url: "https://github.com/guptaprakhariitr",
    },
    license: "MIT",
  };
  // Escape </script> defensively so the JSON payload can never break out of the script block.
  const payload = JSON.stringify(schema).replace(/<\/script/gi, "<\\/script");
  return `<script type="application/ld+json">${payload}</script>`;
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
  // Hardcoded for this deployment; products self-deployed under atlasword.
  // If multi-tenant, this should come from an env var.
  return "atlasword";
}

// ── Team-member invitations ──────────────────────────────────────────────────
//
// A team/pro tier owner can issue N sub-API-keys. Each sub-key:
//   - Inherits the owner's tier + monthly quota (calls roll up against owner).
//   - Has its own audit identity (member_id == the sub-key itself).
//   - Can be revoked independently of the owner's key.
//
// KV layout:
//   "team:<owner-apikey>"        -> TeamRecord  { member_ids: string[] }
//   "team-member:<sub-apikey>"   -> TeamMemberRecord { owner_api_key, member_email, created_at, label }
//
// The sidecar `team:` key keeps existing `key:` records unchanged so older
// accounts still JSON-parse against the original KeyRecord shape.

interface TeamMemberView {
  id: string;            // == sub-API-key
  email: string;
  label?: string;
  created_at: string;    // ISO
}

async function loadTeamRecord(usage: KVNamespace, ownerApiKey: string): Promise<TeamRecord> {
  return (await usage.get<TeamRecord>(`team:${ownerApiKey}`, "json")) ?? { member_ids: [] };
}

async function saveTeamRecord(usage: KVNamespace, ownerApiKey: string, rec: TeamRecord): Promise<void> {
  if (rec.member_ids.length === 0) {
    await usage.delete(`team:${ownerApiKey}`);
    return;
  }
  await usage.put(`team:${ownerApiKey}`, JSON.stringify(rec));
}

async function listTeamMembers(usage: KVNamespace, ownerApiKey: string): Promise<TeamMemberView[]> {
  const team = await loadTeamRecord(usage, ownerApiKey);
  const out: TeamMemberView[] = [];
  for (const id of team.member_ids) {
    const m = await usage.get<TeamMemberRecord>(`team-member:${id}`, "json");
    if (!m) continue; // dangling reference (e.g. external delete) — skip silently
    out.push({ id, email: m.member_email, label: m.label, created_at: new Date(m.created_at).toISOString() });
  }
  return out;
}

/**
 * GET /account/team — list the authenticated owner's current sub-keys.
 *
 * - 401 if no Authorization header.
 * - 404 if the API key is unknown.
 * - 403 if the caller is on a tier that can't issue team members (free / solo)
 *   or is themselves a sub-key (only the owner can manage seats).
 */
export async function handleTeamList(request: Request, env: CheckoutEnv): Promise<Response> {
  const apiKey = extractBearer(request);
  if (!apiKey) return json({ error: "Missing Authorization header", hint: "Send Authorization: Bearer <your owner mck_ key>." }, 401);

  const resolved = await resolveKey(apiKey, env.USAGE);
  if (resolved.status === "anonymous") return json({ error: "Unknown API key" }, 404);
  if (resolved.is_team_member) {
    return json({ error: "Only the team owner can manage seats", hint: "Ask the owner of this subscription to invite or revoke members." }, 403);
  }
  const maxSeats = TEAM_SEAT_LIMITS[resolved.tier];
  if (maxSeats <= 0) {
    return json({
      error: "Team invitations require the team or pro tier",
      tier: resolved.tier,
      hint: "Upgrade at /upgrade?tier=team to unlock 5 seats, or /upgrade?tier=pro for 25 seats.",
      upgradeUrl: "/upgrade?tier=team",
    }, 403);
  }

  const members = await listTeamMembers(env.USAGE, apiKey);
  return json({
    tier: resolved.tier,
    max_seats: maxSeats,
    used_seats: members.length,
    members,
  });
}

/**
 * POST /account/team/invite — mint a sub-API-key for a teammate.
 * Body: { email: string, label?: string }
 */
export async function handleTeamInvite(request: Request, env: CheckoutEnv, origin: string): Promise<Response> {
  const apiKey = extractBearer(request);
  if (!apiKey) return json({ error: "Missing Authorization header" }, 401);

  const resolved = await resolveKey(apiKey, env.USAGE);
  if (resolved.status === "anonymous") return json({ error: "Unknown API key" }, 404);
  if (resolved.is_team_member) return json({ error: "Only the team owner can invite members" }, 403);
  const maxSeats = TEAM_SEAT_LIMITS[resolved.tier];
  if (maxSeats <= 0) {
    return json({ error: "Team invitations require the team or pro tier", tier: resolved.tier, upgradeUrl: "/upgrade?tier=team" }, 403);
  }

  let body: { email?: unknown; label?: unknown };
  try { body = (await request.json()) as { email?: unknown; label?: unknown }; }
  catch { return json({ error: "Invalid JSON body" }, 400); }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const label = typeof body.label === "string" ? body.label.trim().slice(0, 80) : undefined;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ error: "Body must include a valid 'email' string" }, 400);
  }

  const team = await loadTeamRecord(env.USAGE, apiKey);
  if (team.member_ids.length >= maxSeats) {
    return json({
      error: "Seat limit reached",
      max_seats: maxSeats,
      used_seats: team.member_ids.length,
      hint: resolved.tier === "team" ? "Upgrade to pro for 25 seats: /upgrade?tier=pro" : "Revoke an existing seat before inviting another.",
    }, 409);
  }

  // Reject duplicates by email (case-insensitive). O(seats) — capped at 25.
  for (const id of team.member_ids) {
    const m = await env.USAGE.get<TeamMemberRecord>(`team-member:${id}`, "json");
    if (m && m.member_email.toLowerCase() === email) {
      return json({ error: "Email is already a team member", member_id_hint: id.slice(0, 8) + "…" }, 409);
    }
  }

  // Mint sub-key. Distinct prefix so it's visually obvious in logs which keys are sub-keys.
  const subKey = "tmm_" + crypto.randomUUID().replace(/-/g, "");
  const memberRec: TeamMemberRecord = {
    owner_api_key: apiKey,
    member_email: email,
    created_at: Date.now(),
    label,
  };
  await env.USAGE.put(`team-member:${subKey}`, JSON.stringify(memberRec));
  team.member_ids.push(subKey);
  await saveTeamRecord(env.USAGE, apiKey, team);

  const inviteUrl = `${origin}/team/accept?key=${subKey}`;
  return json({
    sub_api_key: subKey,
    member_id: subKey,
    invite_url: inviteUrl,
    note: "Share invite_url with the invitee. We do not send the email for you yet; copy the link manually. The sub-key inherits your tier and quota.",
  }, 201);
}

/**
 * POST /account/team/revoke — delete a sub-API-key the caller owns.
 * Body: { member_id: string }  (member_id IS the sub-API-key)
 */
export async function handleTeamRevoke(request: Request, env: CheckoutEnv): Promise<Response> {
  const apiKey = extractBearer(request);
  if (!apiKey) return json({ error: "Missing Authorization header" }, 401);

  const resolved = await resolveKey(apiKey, env.USAGE);
  if (resolved.status === "anonymous") return json({ error: "Unknown API key" }, 404);
  if (resolved.is_team_member) return json({ error: "Only the team owner can revoke members" }, 403);

  let body: { member_id?: unknown };
  try { body = (await request.json()) as { member_id?: unknown }; }
  catch { return json({ error: "Invalid JSON body" }, 400); }

  const memberId = typeof body.member_id === "string" ? body.member_id : "";
  if (!memberId) return json({ error: "Body must include 'member_id' (the sub-API-key string)" }, 400);

  const memberRec = await env.USAGE.get<TeamMemberRecord>(`team-member:${memberId}`, "json");
  if (!memberRec) return json({ error: "Unknown member_id" }, 404);
  if (memberRec.owner_api_key !== apiKey) {
    // Don't leak ownership; same response as "not found".
    return json({ error: "Unknown member_id" }, 404);
  }

  await env.USAGE.delete(`team-member:${memberId}`);
  const team = await loadTeamRecord(env.USAGE, apiKey);
  team.member_ids = team.member_ids.filter((id) => id !== memberId);
  await saveTeamRecord(env.USAGE, apiKey, team);

  return json({ revoked: true, member_id: memberId });
}

/**
 * GET /team/accept?key=<sub-key> — invite landing page (HTML).
 * No auth: the URL itself is the secret. We confirm the sub-key exists and
 * show install instructions much like /welcome — minus the upsell, since the
 * invitee's seat is already paid for by the owner.
 */
export async function handleTeamAccept(request: Request, env: CheckoutEnv): Promise<Response> {
  const url = new URL(request.url);
  const subKey = url.searchParams.get("key");
  if (!subKey) {
    return htmlResponse(teamAcceptErrorHtml("Missing ?key= parameter. Open this URL via the invite link you were sent.", env, url), 400);
  }
  const memberRec = await env.USAGE.get<TeamMemberRecord>(`team-member:${subKey}`, "json");
  if (!memberRec) {
    return htmlResponse(teamAcceptErrorHtml("This invite link is invalid or has been revoked. Ask the team owner to re-issue an invite.", env, url), 404);
  }
  const ownerRec = await env.USAGE.get<KeyRecord>(`key:${memberRec.owner_api_key}`, "json");
  return htmlResponse(teamAcceptHtml(subKey, memberRec, ownerRec, env, url), 200);
}

function teamAcceptHtml(subKey: string, member: TeamMemberRecord, ownerRec: KeyRecord | null, env: CheckoutEnv, url: URL): string {
  const productName = env.PRODUCT_NAME ?? "your MCP";
  const tagline = env.PRODUCT_TAGLINE ?? "Hosted MCP server for AI agents.";
  const tier = (ownerRec?.tier ?? "team") as Tier;
  const limits = TIER_LIMITS[tier] ?? TIER_LIMITS.team;
  const meta = buildSocialMeta(env, {
    title: `Team invite — ${productName}`,
    description: `Accept your team seat for ${productName}. ${tagline}`,
    url: `${url.origin}/team/accept`,
  });
  const slug = slugFromProduct(env.PRODUCT_NAME);
  const ownerLine = ownerRec?.owner ? `from <code>${escapeHtml(ownerRec.owner)}</code>` : "from your team owner";
  return `<!doctype html><html><head><meta charset="utf-8"><title>Team invite — ${productName}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
${meta}
<style>${PAGE_CSS}</style></head><body>
<h1>Welcome — your team API key is ready.</h1>
<p>You've been invited ${ownerLine} to use <strong>${productName}</strong> on the <strong>${tier}</strong> tier. Your calls share the team's pooled quota; you do not need to subscribe separately.</p>

<h2>Your team API key</h2>
<div class="key">
  <code id="key">${escapeHtml(subKey)}</code>
  <button class="btn" onclick="navigator.clipboard.writeText(document.getElementById('key').textContent); this.textContent='Copied'">Copy</button>
</div>
<p>Save it now; this page will not be shown again. Anyone with this key can use ${productName} against the team's quota.</p>

<h2>What you get</h2>
<dl class="meta">
  <dt>Tier</dt><dd>${tier} (inherited)</dd>
  <dt>Pooled monthly call limit</dt><dd>${limits.monthlyCalls.toLocaleString()} calls (shared across the team)</dd>
  <dt>Rate limit</dt><dd>${limits.ratePerMin} calls / minute (shared)</dd>
  <dt>Invited as</dt><dd>${escapeHtml(member.member_email)}${member.label ? " · " + escapeHtml(member.label) : ""}</dd>
  <dt>Endpoint</dt><dd>https://${slug}.${cfSubdomain()}.workers.dev/mcp</dd>
</dl>

<h2>Install in Cursor / Claude Desktop / Cline</h2>
<pre><code>{
  "mcpServers": {
    "${slug}": {
      "url": "https://${slug}.${cfSubdomain()}.workers.dev/mcp",
      "headers": { "Authorization": "Bearer ${escapeHtml(subKey)}" }
    }
  }
}</code></pre>

<p class="footer">
  This key was issued by the team owner and can be revoked at any time from their account.
  Quota usage rolls up to the owner's subscription — please be mindful when running large batches.
  Questions? Email <a href="mailto:prakshatechnologies@gmail.com">prakshatechnologies@gmail.com</a>.
</p>
</body></html>`;
}

function teamAcceptErrorHtml(message: string, env: CheckoutEnv, url: URL): string {
  const productName = env.PRODUCT_NAME ?? "your MCP";
  const tagline = env.PRODUCT_TAGLINE ?? "Hosted MCP server for AI agents.";
  const meta = buildSocialMeta(env, {
    title: `Invite unavailable — ${productName}`,
    description: tagline,
    url: `${url.origin}/team/accept`,
  });
  return `<!doctype html><html><head><meta charset="utf-8"><title>Invite unavailable — ${productName}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
${meta}
<style>${PAGE_CSS}</style></head><body>
<h1>This invite isn't available.</h1>
<div class="error"><p>${escapeHtml(message)}</p></div>
<p><a href="/" class="btn">Back to ${productName}</a></p>
</body></html>`;
}

async function listTeamMembersForExport(usage: KVNamespace, ownerApiKey: string): Promise<Array<{ id_hash: string; email: string; label?: string; created_at: string }>> {
  const team = await loadTeamRecord(usage, ownerApiKey);
  const out: Array<{ id_hash: string; email: string; label?: string; created_at: string }> = [];
  for (const id of team.member_ids) {
    const m = await usage.get<TeamMemberRecord>(`team-member:${id}`, "json");
    if (!m) continue;
    out.push({
      id_hash: await sha256Hex16(id),
      email: m.member_email,
      label: m.label,
      created_at: new Date(m.created_at).toISOString(),
    });
  }
  return out;
}

function startOfNextMonthMs(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 0, 0, 0, 0);
}

async function sha256Hex16(s: string): Promise<string> {
  const bytes = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return hex.slice(0, 16);
}
