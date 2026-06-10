// Dodo Payments REST client + webhook verification.
// Vendored identically into every Category-1 product.
//
// Why Dodo (vs Stripe): Merchant of Record — Dodo handles GST/VAT/sales-tax
// remittance worldwide so a Bangalore-based solo founder can sell to global
// AI-agent buyers without registering for tax in every jurisdiction.
//
// Docs: https://docs.dodopayments.com/

import { Tier } from "./auth";

export interface DodoEnv {
  DODO_API_KEY: string;
  DODO_WEBHOOK_SECRET: string;
  DODO_BASE?: string;              // override for test mode
  DODO_PRODUCT_ID_SOLO: string;
  DODO_PRODUCT_ID_TEAM: string;
  DODO_PRODUCT_ID_PRO: string;
  UPGRADE_URL: string;
  CUSTOMER_PORTAL_RETURN_URL?: string;
}

const PROD_BASE = "https://api.dodopayments.com";

export interface CheckoutLink {
  payment_link: string;
  payment_id: string;
}

export interface DodoSubscriptionEvent {
  type: "subscription.active" | "subscription.renewed" | "subscription.cancelled" | "subscription.failed" | "payment.succeeded" | "payment.failed";
  data: {
    subscription_id?: string;
    payment_id?: string;
    customer: { customer_id: string; email: string; name?: string };
    product_id?: string;
    status?: string;
    metadata?: Record<string, string>;
  };
}

export class DodoClient {
  constructor(private env: DodoEnv) {}

  private base(): string { return this.env.DODO_BASE || PROD_BASE; }

  productIdForTier(tier: Tier): string | null {
    switch (tier) {
      case "solo": return this.env.DODO_PRODUCT_ID_SOLO || null;
      case "team": return this.env.DODO_PRODUCT_ID_TEAM || null;
      case "pro":  return this.env.DODO_PRODUCT_ID_PRO  || null;
      case "free": return null;
    }
  }

  tierForProductId(productId: string): Tier | null {
    if (productId === this.env.DODO_PRODUCT_ID_SOLO) return "solo";
    if (productId === this.env.DODO_PRODUCT_ID_TEAM) return "team";
    if (productId === this.env.DODO_PRODUCT_ID_PRO)  return "pro";
    return null;
  }

  /** Create a hosted checkout link for a tier upgrade.
   *  Dodo requires `customer.email` + a placeholder `billing` address; the
   *  buyer overrides them on the hosted checkout page. We send blank-ish
   *  defaults if no email arrived via the upgrade-link query string.
   */
  async createCheckoutLink(opts: { tier: Exclude<Tier, "free">; customer_email?: string; customer_name?: string; success_url: string; metadata?: Record<string, string> }): Promise<CheckoutLink> {
    const productId = this.productIdForTier(opts.tier);
    if (!productId) throw new Error(`No Dodo product configured for tier ${opts.tier}`);

    const email = opts.customer_email || "unknown@example.com";
    const name = opts.customer_name || email.split("@")[0] || "Customer";

    const r = await fetch(`${this.base()}/subscriptions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.env.DODO_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        product_id: productId,
        quantity: 1,
        payment_link: true,
        return_url: opts.success_url,
        customer: { email, name },
        billing: { city: "Bengaluru", country: "IN", state: "KA", street: "—", zipcode: "560001" },
        metadata: opts.metadata ?? {},
      }),
    });
    if (!r.ok) {
      const body = await r.text();
      throw new Error(`Dodo create-subscription ${r.status}: ${body.slice(0, 200)}`);
    }
    const json = await r.json() as { payment_link?: string; subscription_id?: string; payment_id?: string };
    if (!json.payment_link) throw new Error("Dodo did not return a payment_link");
    return { payment_link: json.payment_link, payment_id: json.payment_id ?? json.subscription_id ?? "" };
  }

  /** Generate a Customer-Portal session URL for an existing subscriber. */
  async createCustomerPortalLink(customer_id: string): Promise<{ portal_url: string }> {
    const r = await fetch(`${this.base()}/customers/${customer_id}/customer-portal/session`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.env.DODO_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ return_url: this.env.CUSTOMER_PORTAL_RETURN_URL || this.env.UPGRADE_URL }),
    });
    if (!r.ok) throw new Error(`Dodo customer-portal ${r.status}`);
    const json = await r.json() as { link?: string; portal_url?: string };
    return { portal_url: json.portal_url || json.link || "" };
  }
}

// ── Webhook verification (Standard Webhooks compatible) ──────────────────────
// Dodo follows the Standard Webhooks signing convention:
//   - Header `webhook-id` (unique event id)
//   - Header `webhook-timestamp` (unix seconds)
//   - Header `webhook-signature` (space-separated list of `v1,<base64-hmac>`)
// Signed payload: `${id}.${timestamp}.${body}` HMAC-SHA256 with the secret.

export interface WebhookHeaders {
  id: string;
  timestamp: string;
  signature: string;
}

export function extractWebhookHeaders(request: Request): WebhookHeaders | null {
  const id = request.headers.get("webhook-id");
  const timestamp = request.headers.get("webhook-timestamp");
  const signature = request.headers.get("webhook-signature");
  if (!id || !timestamp || !signature) return null;
  return { id, timestamp, signature };
}

/** Verify Dodo's webhook signature. Returns true if valid AND within 5-minute clock skew. */
export async function verifyWebhookSignature(
  rawBody: string,
  headers: WebhookHeaders,
  secret: string,
  nowMs: number = Date.now()
): Promise<boolean> {
  const ts = parseInt(headers.timestamp, 10) * 1000;
  if (isNaN(ts)) return false;
  if (Math.abs(nowMs - ts) > 5 * 60 * 1000) return false;  // anti-replay window

  const payload = `${headers.id}.${headers.timestamp}.${rawBody}`;
  const secretBytes = base64ToBytes(stripWhsecPrefix(secret));
  const key = await crypto.subtle.importKey("raw", secretBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sigBytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  const expected = bytesToBase64(new Uint8Array(sigBytes));

  // The signature header may carry multiple versions, e.g. "v1,<base64> v1,<base64>"
  // We accept if any v1 entry matches.
  for (const sig of headers.signature.split(/\s+/)) {
    const [v, val] = sig.split(",");
    if (v !== "v1") continue;
    if (constantTimeEqual(val, expected)) return true;
  }
  return false;
}

function stripWhsecPrefix(secret: string): string {
  return secret.startsWith("whsec_") ? secret.slice(6) : secret;
}

function base64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
