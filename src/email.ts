// Transactional email shim (Brevo).
// Vendored identically into every Category-1 product.
//
// Provides four high-level helpers used by webhook.ts + checkout.ts:
//   - sendWelcomeEmail            (on subscription.active + free signup)
//   - sendPaymentReceipt          (on payment.succeeded)
//   - sendCancellationEmail       (on subscription.cancelled)
//   - sendSupportTicketForward    (on POST /support)
//
// All helpers silently no-op if env.BREVO_API_KEY is unset (graceful
// degradation: the product still runs without email). Brevo API errors
// are caught + logged; we never let an email failure block the caller.

export interface EmailEnv {
  BREVO_API_KEY?: string;
  FROM_EMAIL?: string;             // default "prakshatechnologies@gmail.com"
  SUPPORT_FORWARD_EMAIL?: string;  // default "prakshatechnologies@gmail.com"
  PRODUCT_NAME?: string;
  PRODUCT_URL?: string;
}

const BREVO_ENDPOINT = "https://api.brevo.com/v3/smtp/email";

// Brevo refuses unverified senders. Account-verified address acts as a fallback
// FROM whenever the user-supplied FROM_EMAIL is rejected; the human-friendly
// inbox is still passed via reply-to and footer.
const FALLBACK_FROM_EMAIL = "prakhar.cognizance@gmail.com";

interface SendEmailOpts {
  to: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  /** Override the FROM address. Defaults to env.FROM_EMAIL. */
  from?: string;
  fromName?: string;
}

interface BrevoResponse {
  messageId?: string;
}

/**
 * Low-level Brevo wrapper. Returns the parsed Brevo response on success,
 * or `null` if the API key isn't configured / the request failed after
 * one retry. Never throws — callers can ignore the return value safely.
 *
 * One automatic retry on 5xx (Brevo occasionally 502s under load).
 * 4xx errors (e.g. "sender not allowed") are NOT retried; we fall back to
 * the verified account-owner FROM address once, then give up.
 */
export async function sendEmail(env: EmailEnv, opts: SendEmailOpts): Promise<BrevoResponse | null> {
  if (!env.BREVO_API_KEY) return null;
  const fromEmail = opts.from ?? env.FROM_EMAIL ?? FALLBACK_FROM_EMAIL;
  const fromName = opts.fromName ?? env.PRODUCT_NAME ?? "MCP";

  const body: Record<string, unknown> = {
    sender: { email: fromEmail, name: fromName },
    to: [{ email: opts.to }],
    subject: opts.subject,
    htmlContent: opts.html,
  };
  if (opts.text) body.textContent = opts.text;
  if (opts.replyTo) body.replyTo = { email: opts.replyTo };

  const doFetch = async (): Promise<Response> => fetch(BREVO_ENDPOINT, {
    method: "POST",
    headers: { "api-key": env.BREVO_API_KEY!, "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify(body),
  });

  try {
    let r = await doFetch();
    if (r.status >= 500 && r.status < 600) {
      // One retry on transient 5xx.
      r = await doFetch();
    }
    if (r.ok) return (await r.json().catch(() => ({}))) as BrevoResponse;

    const txt = await r.text().catch(() => "");
    // Sender-not-verified fallback: retry once from the account-owner address.
    if (r.status === 400 && /sender|not allowed|unauthorized/i.test(txt) && fromEmail !== FALLBACK_FROM_EMAIL) {
      const retry = await fetch(BREVO_ENDPOINT, {
        method: "POST",
        headers: { "api-key": env.BREVO_API_KEY!, "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({ ...body, sender: { email: FALLBACK_FROM_EMAIL, name: fromName } }),
      });
      if (retry.ok) return (await retry.json().catch(() => ({}))) as BrevoResponse;
      console.error("Brevo send failed (after fallback FROM):", retry.status, await retry.text().catch(() => ""));
      return null;
    }
    console.error("Brevo send failed:", r.status, txt);
    return null;
  } catch (err) {
    console.error("Brevo send threw:", err);
    return null;
  }
}

// ── High-level helpers ────────────────────────────────────────────────────────

interface WelcomeOpts {
  to: string;
  apiKey: string;
  tier: string;
  productName: string;
  productUrl?: string;
  accountUrl?: string;
}

export async function sendWelcomeEmail(env: EmailEnv, opts: WelcomeOpts): Promise<BrevoResponse | null> {
  const productUrl = opts.productUrl || env.PRODUCT_URL || "";
  const accountUrl = opts.accountUrl || (productUrl ? `${productUrl}/account` : "/account");
  const welcomeUrl = productUrl ? `${productUrl}/welcome` : "/welcome";
  const slug = opts.productName.replace(/[^a-z0-9-]/gi, "");
  const endpoint = productUrl ? `${productUrl}/mcp` : `/mcp`;

  const subject = `Welcome to ${opts.productName} — your API key inside`;

  const cursorSnippet = `{
  "mcpServers": {
    "${slug}": {
      "url": "${endpoint}",
      "headers": { "Authorization": "Bearer ${opts.apiKey}" }
    }
  }
}`;

  const html = `<!doctype html><html><body style="font:15px/1.55 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;color:#1a1a1a;max-width:640px;margin:0 auto;padding:1.2rem">
<h2 style="margin:0 0 .6rem">Welcome to ${escapeHtml(opts.productName)}</h2>
<p>You're on the <strong>${escapeHtml(opts.tier)}</strong> tier. Your API key is below — keep it secret; it carries all the privileges of your subscription.</p>
<h3 style="margin:1.4rem 0 .4rem">Your API key</h3>
<pre style="background:#f5f5f7;border:1px solid #e0e0e6;padding:.8rem 1rem;border-radius:8px;font-size:14px;overflow-x:auto"><code>${escapeHtml(opts.apiKey)}</code></pre>
<h3 style="margin:1.4rem 0 .4rem">Install in Cursor / Claude Desktop / Cline</h3>
<p>Add this to your MCP config (Cursor: <code>~/.cursor/mcp.json</code>, Claude Desktop: <code>claude_desktop_config.json</code>):</p>
<pre style="background:#1f2328;color:#e6edf3;padding:1rem;border-radius:8px;font-size:13px;overflow-x:auto"><code>${escapeHtml(cursorSnippet)}</code></pre>
<h3 style="margin:1.4rem 0 .4rem">Self-service</h3>
<ul style="padding-left:1.1rem">
  <li><a href="${escapeAttr(welcomeUrl)}">Welcome / install page</a></li>
  <li><a href="${escapeAttr(accountUrl)}">View account &amp; usage</a></li>
</ul>
<p style="margin-top:2rem;padding-top:1rem;border-top:1px solid #e0e0e6;font-size:13px;color:#666">
  Questions or trouble? Reply to this email or write to
  <a href="mailto:prakshatechnologies@gmail.com">prakshatechnologies@gmail.com</a>.
</p>
</body></html>`;

  const text = [
    `Welcome to ${opts.productName}`,
    ``,
    `You're on the ${opts.tier} tier. Your API key:`,
    ``,
    `    ${opts.apiKey}`,
    ``,
    `Install (Cursor / Claude Desktop / Cline) — add to your MCP config:`,
    ``,
    cursorSnippet,
    ``,
    `Self-service:`,
    `  Welcome page:  ${welcomeUrl}`,
    `  Account:       ${accountUrl}`,
    ``,
    `Questions? Reply to this email or write to prakshatechnologies@gmail.com.`,
  ].join("\n");

  return sendEmail(env, { to: opts.to, subject, html, text });
}

interface ReceiptOpts {
  to: string;
  productName: string;
  amount?: string;        // "$9.00", "$29.00", etc.  Pre-formatted by caller.
  currency?: string;      // ISO, optional
  period?: string;        // "Monthly" / "Annual" / etc.
  subscriptionId?: string;
  paymentId?: string;
  portalUrl?: string;
}

export async function sendPaymentReceipt(env: EmailEnv, opts: ReceiptOpts): Promise<BrevoResponse | null> {
  const amountLabel = opts.amount || (opts.currency ? `(${opts.currency})` : "");
  const subject = amountLabel
    ? `Receipt — ${opts.productName} — ${amountLabel}`
    : `Receipt — ${opts.productName}`;

  const rows: string[] = [];
  if (opts.amount) rows.push(`<tr><td style="padding:.25rem .8rem .25rem 0;color:#666">Amount</td><td><strong>${escapeHtml(opts.amount)}</strong></td></tr>`);
  if (opts.period) rows.push(`<tr><td style="padding:.25rem .8rem .25rem 0;color:#666">Period</td><td>${escapeHtml(opts.period)}</td></tr>`);
  if (opts.subscriptionId) rows.push(`<tr><td style="padding:.25rem .8rem .25rem 0;color:#666">Subscription</td><td><code>${escapeHtml(opts.subscriptionId)}</code></td></tr>`);
  if (opts.paymentId) rows.push(`<tr><td style="padding:.25rem .8rem .25rem 0;color:#666">Payment ID</td><td><code>${escapeHtml(opts.paymentId)}</code></td></tr>`);

  const portalLine = opts.portalUrl
    ? `<p><a href="${escapeAttr(opts.portalUrl)}">View in customer portal</a></p>`
    : `<p>Manage your subscription from <a href="${escapeAttr(env.PRODUCT_URL ? env.PRODUCT_URL + "/account" : "/account")}">your account page</a>.</p>`;

  const html = `<!doctype html><html><body style="font:15px/1.55 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;color:#1a1a1a;max-width:640px;margin:0 auto;padding:1.2rem">
<h2 style="margin:0 0 .6rem">Payment received</h2>
<p>Thanks for your payment to <strong>${escapeHtml(opts.productName)}</strong>.</p>
<table style="border-collapse:collapse;margin:1rem 0;font-size:14px">${rows.join("")}</table>
${portalLine}
<p style="margin-top:2rem;padding-top:1rem;border-top:1px solid #e0e0e6;font-size:13px;color:#666">
  Questions about this receipt? Reply to this email or write to
  <a href="mailto:prakshatechnologies@gmail.com">prakshatechnologies@gmail.com</a>.
</p>
</body></html>`;

  const text = [
    `Payment received — ${opts.productName}`,
    ``,
    opts.amount ? `Amount: ${opts.amount}` : null,
    opts.period ? `Period: ${opts.period}` : null,
    opts.subscriptionId ? `Subscription: ${opts.subscriptionId}` : null,
    opts.paymentId ? `Payment ID: ${opts.paymentId}` : null,
    ``,
    opts.portalUrl ? `Customer portal: ${opts.portalUrl}` : null,
    ``,
    `Questions? Reply to this email or write to prakshatechnologies@gmail.com.`,
  ].filter(Boolean).join("\n");

  return sendEmail(env, { to: opts.to, subject, html, text });
}

interface CancellationOpts {
  to: string;
  productName: string;
  productUrl?: string;
  periodEnd?: string;   // ISO string or human-readable
}

export async function sendCancellationEmail(env: EmailEnv, opts: CancellationOpts): Promise<BrevoResponse | null> {
  const productUrl = opts.productUrl || env.PRODUCT_URL || "";
  const exportUrl = productUrl ? `${productUrl}/account/export` : "/account/export";
  const upgradeUrl = productUrl ? `${productUrl}/upgrade?tier=solo` : "/upgrade?tier=solo";

  const subject = `Your ${opts.productName} subscription was cancelled`;
  const periodLine = opts.periodEnd
    ? `<p>Your API key remains valid until <strong>${escapeHtml(opts.periodEnd)}</strong>. After that it will stop accepting requests.</p>`
    : `<p>Your API key remains valid until the end of the current billing period. After that it will stop accepting requests.</p>`;

  const html = `<!doctype html><html><body style="font:15px/1.55 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;color:#1a1a1a;max-width:640px;margin:0 auto;padding:1.2rem">
<h2 style="margin:0 0 .6rem">Subscription cancelled</h2>
<p>We've confirmed the cancellation of your <strong>${escapeHtml(opts.productName)}</strong> subscription. Sorry to see you go.</p>
${periodLine}
<h3 style="margin:1.4rem 0 .4rem">Before you leave</h3>
<ul style="padding-left:1.1rem">
  <li><a href="${escapeAttr(exportUrl)}">Export your data (GDPR)</a> — a JSON dump of every record we hold tied to your API key.</li>
  <li><a href="${escapeAttr(upgradeUrl)}">Resubscribe</a> — your existing data will reattach if you use the same email.</li>
</ul>
<p style="margin-top:2rem;padding-top:1rem;border-top:1px solid #e0e0e6;font-size:13px;color:#666">
  Feedback welcome — reply to this email and tell us why you left. Or write to
  <a href="mailto:prakshatechnologies@gmail.com">prakshatechnologies@gmail.com</a>.
</p>
</body></html>`;

  const text = [
    `Subscription cancelled — ${opts.productName}`,
    ``,
    opts.periodEnd
      ? `Your API key remains valid until ${opts.periodEnd}.`
      : `Your API key remains valid until the end of the current billing period.`,
    ``,
    `Before you leave:`,
    `  Export your data (GDPR):  ${exportUrl}`,
    `  Resubscribe:              ${upgradeUrl}`,
    ``,
    `Feedback welcome — reply to this email or write to prakshatechnologies@gmail.com.`,
  ].join("\n");

  return sendEmail(env, { to: opts.to, subject, html, text });
}

interface SupportTicketOpts {
  ticketId: string;
  userName: string;
  userEmail: string;
  userSubject: string;
  userMessage: string;
  productName: string;
  productUrl?: string;
}

export async function sendSupportTicketForward(env: EmailEnv, opts: SupportTicketOpts): Promise<BrevoResponse | null> {
  const operator = env.SUPPORT_FORWARD_EMAIL || "prakshatechnologies@gmail.com";
  const productUrl = opts.productUrl || env.PRODUCT_URL || "";
  const adminLink = productUrl ? `${productUrl}/admin/support` : "/admin/support";

  const subject = `[${opts.productName} support] ${opts.userSubject}`;

  const html = `<!doctype html><html><body style="font:15px/1.55 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;color:#1a1a1a;max-width:640px;margin:0 auto;padding:1.2rem">
<p style="color:#666;font-size:13px;margin:0 0 1rem"><strong>${escapeHtml(opts.productName)}</strong> · support ticket</p>
<table style="border-collapse:collapse;margin:0 0 1rem;font-size:14px">
  <tr><td style="padding:.25rem .8rem .25rem 0;color:#666">From</td><td><strong>${escapeHtml(opts.userName)}</strong> &lt;<a href="mailto:${escapeAttr(opts.userEmail)}">${escapeHtml(opts.userEmail)}</a>&gt;</td></tr>
  <tr><td style="padding:.25rem .8rem .25rem 0;color:#666">Subject</td><td>${escapeHtml(opts.userSubject)}</td></tr>
  <tr><td style="padding:.25rem .8rem .25rem 0;color:#666">Ticket</td><td><code>${escapeHtml(opts.ticketId)}</code></td></tr>
</table>
<h3 style="margin:1.2rem 0 .4rem">Message</h3>
<div style="background:#f5f5f7;border:1px solid #e0e0e6;padding:.8rem 1rem;border-radius:8px;white-space:pre-wrap;font-size:14px">${escapeHtml(opts.userMessage)}</div>
<p style="margin-top:1.5rem"><a href="${escapeAttr(adminLink)}">View in admin panel</a> · reply to this email to respond directly to ${escapeHtml(opts.userEmail)}.</p>
</body></html>`;

  const text = [
    `${opts.productName} — support ticket`,
    ``,
    `From: ${opts.userName} <${opts.userEmail}>`,
    `Subject: ${opts.userSubject}`,
    `Ticket: ${opts.ticketId}`,
    ``,
    `Message:`,
    opts.userMessage,
    ``,
    `Admin panel: ${adminLink}`,
    `Reply to this email to respond directly to ${opts.userEmail}.`,
  ].join("\n");

  return sendEmail(env, {
    to: operator,
    subject,
    html,
    text,
    replyTo: opts.userEmail,
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}
