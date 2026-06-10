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

export interface WebhookEnv extends DodoEnv {
  USAGE: KVNamespace;
  RESEND_API_KEY?: string;
  FROM_EMAIL?: string;          // e.g. "billing@your-domain.com"
  PRODUCT_NAME?: string;        // e.g. "sec-edgar-mcp"
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
      await maybeSendKeyEmail(env, event.data.customer.email, apiKey, tier);
      return new Response(JSON.stringify({ ok: true, apiKey_issued: !existing }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }

    case "subscription.renewed": {
      if (!event.data.subscription_id) return new Response("Missing subscription_id", { status: 400 });
      await updateKeyStatus({
        usage: env.USAGE,
        subscriptionId: event.data.subscription_id,
        status: "active",
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    case "subscription.cancelled": {
      if (!event.data.subscription_id) return new Response("Missing subscription_id", { status: 400 });
      await updateKeyStatus({
        usage: env.USAGE,
        subscriptionId: event.data.subscription_id,
        status: "cancelled",
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    case "subscription.failed":
    case "payment.failed": {
      if (event.data.subscription_id) {
        await updateKeyStatus({
          usage: env.USAGE,
          subscriptionId: event.data.subscription_id,
          status: "past_due",
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    case "payment.succeeded":
      // Pure payment-succeeded without subscription_id (one-off purchase): no key issuance.
      // If there is a subscription_id, subscription.renewed will fire too — handled there.
      return new Response(JSON.stringify({ ok: true, note: "no-op" }), { status: 200, headers: { "Content-Type": "application/json" } });

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
