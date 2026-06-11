// Dodo Payments webhook handler.
// Vendored identically into every Category-1 product.
//
// Routes /webhooks/dodo POST → verifies signature → dispatches to key issuance
// or status update. Returns 200 on success, 4xx on signature failure.

import {
  DodoClient, DodoEnv, DodoSubscriptionEvent,
  extractWebhookHeaders, verifyWebhookSignature,
} from "./dodo";
import {
  mintApiKey, updateKeyStatus, getKeyBySubscription,
  Tier,
} from "./auth";
import {
  EmailEnv,
  sendWelcomeEmail,
  sendPaymentReceipt,
  sendCancellationEmail,
} from "./email";

// 90-day TTL for stored event log entries (matches the GDPR export window in /account/export).
const EVENT_TTL_SECONDS = 60 * 60 * 24 * 90;

/**
 * Records a webhook event in KV under `event:<apikey>:<ts>:<type>` so that
 * the GDPR-export endpoint (/account/export) can return a user-visible audit
 * trail of subscription / payment events. Best-effort: any failure is logged
 * but never blocks the webhook response.
 */
async function logEvent(
  usage: KVNamespace,
  apiKey: string,
  type: string,
  data: Record<string, unknown>
): Promise<void> {
  const at = new Date().toISOString();
  const key = `event:${apiKey}:${at}:${type}`;
  try {
    await usage.put(
      key,
      JSON.stringify({ type, at, data }),
      { expirationTtl: EVENT_TTL_SECONDS }
    );
  } catch (err) {
    console.error("logEvent failed:", err);
  }
}

export interface WebhookEnv extends DodoEnv, EmailEnv {
  USAGE: KVNamespace;
  RESEND_API_KEY?: string;       // legacy — superseded by BREVO_API_KEY
  FROM_EMAIL?: string;          // e.g. "prakshatechnologies@gmail.com"
  SUPPORT_FORWARD_EMAIL?: string;
  PRODUCT_NAME?: string;        // e.g. "sec-edgar-mcp"
  PRODUCT_URL?: string;
  BREVO_API_KEY?: string;
}

export async function handleDodoWebhook(request: Request, env: WebhookEnv): Promise<Response> {
  const headers = extractWebhookHeaders(request);
  if (!headers) return new Response("Missing webhook headers", { status: 400 });

  const rawBody = await request.text();
  const ok = await verifyWebhookSignature(rawBody, headers, env.DODO_WEBHOOK_SECRET);
  if (!ok) return new Response("Invalid signature", { status: 401 });

  let event: DodoSubscriptionEvent;
  try { event = JSON.parse(rawBody); }
  catch { return new Response("Invalid JSON", { status: 400 }); }

  const dodo = new DodoClient(env);

  switch (event.type) {
    case "subscription.active": {
      const productId = event.data.product_id ?? "";
      const tier = dodo.tierForProductId(productId);
      if (!tier || tier === "free") {
        return new Response(`Unknown product_id: ${productId}`, { status: 422 });
      }
      // Idempotency: if this subscription already has a key, reuse it instead of minting again.
      const existing = event.data.subscription_id ? await getKeyBySubscription(env.USAGE, event.data.subscription_id) : null;
      const apiKey = existing?.apiKey ?? await mintApiKey({
        usage: env.USAGE,
        tier,
        owner: event.data.customer.email,
        customerId: event.data.customer.customer_id,
        subscriptionId: event.data.subscription_id,
      });
      // If this is a re-activation of an existing key (e.g. retry after a failed renewal),
      // make sure status flips back to active.
      if (existing && existing.rec.status !== "active") {
        await updateKeyStatus({
          usage: env.USAGE,
          subscriptionId: event.data.subscription_id!,
          status: "active",
          newTier: tier as Tier,
        });
      }
      // Write the welcome-token pointer so /welcome can resolve the key without
      // requiring the buyer to authenticate (they don't have the key yet at
      // redirect time). 24-hour TTL is plenty — buyers always see the page
      // within seconds of payment; the entry expires on its own.
      const welcomeToken = event.data.metadata?.welcome_token;
      if (welcomeToken) {
        await env.USAGE.put(`welcome:${welcomeToken}`, apiKey, { expirationTtl: 60 * 60 * 24 });
      }
      await maybeSendKeyEmail(env, event.data.customer.email, apiKey, tier);
      // Brevo welcome email — runs in addition to the legacy Resend path; both
      // no-op if their respective API keys aren't configured.
      if (event.data.customer.email) {
        await sendWelcomeEmail(env, {
          to: event.data.customer.email,
          apiKey,
          tier,
          productName: env.PRODUCT_NAME ?? "your MCP",
          productUrl: env.PRODUCT_URL,
        });
      }
      await logEvent(env.USAGE, apiKey, "subscription.active", {
        tier, subscription_id: event.data.subscription_id, customer_id: event.data.customer.customer_id,
      });
      return new Response(JSON.stringify({ ok: true, apiKey_issued: !existing, welcome_token_set: !!welcomeToken }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }

    case "subscription.renewed": {
      if (!event.data.subscription_id) return new Response("Missing subscription_id", { status: 400 });
      const updated = await updateKeyStatus({
        usage: env.USAGE,
        subscriptionId: event.data.subscription_id,
        status: "active",
      });
      if (updated) await logEvent(env.USAGE, updated.apiKey, "subscription.renewed", { subscription_id: event.data.subscription_id });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    case "subscription.cancelled": {
      if (!event.data.subscription_id) return new Response("Missing subscription_id", { status: 400 });
      const updated = await updateKeyStatus({
        usage: env.USAGE,
        subscriptionId: event.data.subscription_id,
        status: "cancelled",
      });
      if (updated) {
        await logEvent(env.USAGE, updated.apiKey, "subscription.cancelled", { subscription_id: event.data.subscription_id });
        const cancelEmail = event.data.customer?.email || updated.rec.owner;
        if (cancelEmail) {
          await sendCancellationEmail(env, {
            to: cancelEmail,
            productName: env.PRODUCT_NAME ?? "your MCP",
            productUrl: env.PRODUCT_URL,
            periodEnd: updated.rec.monthlyResetAt ? new Date(updated.rec.monthlyResetAt).toISOString().slice(0, 10) : undefined,
          });
        }
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    case "subscription.failed":
    case "payment.failed": {
      if (event.data.subscription_id) {
        const updated = await updateKeyStatus({
          usage: env.USAGE,
          subscriptionId: event.data.subscription_id,
          status: "past_due",
        });
        if (updated) await logEvent(env.USAGE, updated.apiKey, event.type, { subscription_id: event.data.subscription_id });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    case "payment.succeeded": {
      // Pure payment-succeeded without subscription_id (one-off purchase): no key issuance.
      // If there is a subscription_id, subscription.renewed will fire too — handled there.
      if (event.data.subscription_id) {
        const existing = await getKeyBySubscription(env.USAGE, event.data.subscription_id);
        if (existing) await logEvent(env.USAGE, existing.apiKey, "payment.succeeded", { subscription_id: event.data.subscription_id });
      }
      // Send a receipt email — driven entirely off the event payload so this
      // works for both subscription and one-off charges. Dodo doesn't include
      // a guaranteed amount field, so we pass whatever's present on the event
      // and let the helper omit absent fields gracefully.
      const receiptTo = event.data.customer?.email;
      if (receiptTo) {
        const anyData = event.data as unknown as { amount?: number | string; currency?: string; total?: number | string };
        const amountRaw = anyData.amount ?? anyData.total;
        const currency = anyData.currency ? String(anyData.currency).toUpperCase() : undefined;
        let amount: string | undefined;
        if (amountRaw !== undefined && amountRaw !== null) {
          const n = typeof amountRaw === "number" ? amountRaw : Number(amountRaw);
          if (!Number.isNaN(n)) {
            // Dodo amounts are minor units (cents) for fiat. Convert if >= 100 to avoid "0.09" gotchas.
            const major = n >= 100 ? n / 100 : n;
            amount = currency === "USD" || !currency ? `$${major.toFixed(2)}` : `${major.toFixed(2)} ${currency}`;
          }
        }
        await sendPaymentReceipt(env, {
          to: receiptTo,
          productName: env.PRODUCT_NAME ?? "your MCP",
          amount,
          currency,
          period: event.data.subscription_id ? "Monthly" : undefined,
          subscriptionId: event.data.subscription_id,
          paymentId: event.data.payment_id,
          portalUrl: env.PRODUCT_URL ? `${env.PRODUCT_URL}/account` : undefined,
        });
      }
      return new Response(JSON.stringify({ ok: true, note: "no-op" }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    default:
      return new Response(JSON.stringify({ ok: true, note: `event type ${event.type} ignored` }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
  }
}

async function maybeSendKeyEmail(env: WebhookEnv, to: string, apiKey: string, tier: Tier): Promise<void> {
  if (!env.RESEND_API_KEY || !env.FROM_EMAIL) {
    // No email provider configured. Customer will see the key in their dashboard via /account/keys.
    return;
  }
  const productName = env.PRODUCT_NAME ?? "your MCP";
  const body = {
    from: env.FROM_EMAIL,
    to,
    subject: `Your API key for ${productName} (${tier} tier)`,
    text: [
      `Hi,`,
      ``,
      `Thanks for subscribing to ${productName} on the ${tier} tier.`,
      ``,
      `Your API key:`,
      ``,
      `    ${apiKey}`,
      ``,
      `Use it in the Authorization header:`,
      ``,
      `    Authorization: Bearer ${apiKey}`,
      ``,
      `Manage your subscription in the customer portal: ${env.UPGRADE_URL}/account`,
      ``,
      `— ${productName}`,
    ].join("\n"),
  };
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error("Failed to send key email:", err);
  }
}
