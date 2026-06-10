// Tests for the Dodo Payments webhook handler.
// Same test vendored across all Category-1 products (no product-specific bits).

import { beforeEach, describe, expect, it } from "vitest";
import { handleDodoWebhook } from "../src/webhook";
import { resolveKey } from "../src/auth";
import { DodoSubscriptionEvent } from "../src/dodo";

class FakeKv {
  store = new Map<string, string>();
  async get(key: string, type?: "text" | "json"): Promise<any> {
    const v = this.store.get(key); if (v === undefined) return null;
    if (type === "json") return JSON.parse(v); return v;
  }
  async put(key: string, value: string): Promise<void> { this.store.set(key, value); }
  async delete(key: string): Promise<void> { this.store.delete(key); }
}

const WEBHOOK_SECRET = "whsec_dGVzdC13ZWJob29rLXNlY3JldC1mb3ItdGVzdGluZw";  // base64("test-webhook-secret-for-testing")

const baseEnv = {
  USAGE: new FakeKv() as unknown as KVNamespace,
  DODO_API_KEY: "test-api-key",
  DODO_WEBHOOK_SECRET: WEBHOOK_SECRET,
  DODO_BASE: "https://test.dodopayments.com",
  DODO_PRODUCT_ID_SOLO: "pdt_solo_xxx",
  DODO_PRODUCT_ID_TEAM: "pdt_team_yyy",
  DODO_PRODUCT_ID_PRO:  "pdt_pro_zzz",
  UPGRADE_URL: "https://test.workers.dev/upgrade",
  PRODUCT_NAME: "test-mcp",
};

beforeEach(() => {
  (baseEnv.USAGE as any).store = new Map();
});

/** Build a signed Dodo webhook request. */
async function signedRequest(event: DodoSubscriptionEvent, secret: string = WEBHOOK_SECRET, opts: { skewMs?: number } = {}): Promise<Request> {
  const body = JSON.stringify(event);
  const id = `evt_${crypto.randomUUID()}`;
  const timestamp = String(Math.floor((Date.now() + (opts.skewMs ?? 0)) / 1000));
  const payload = `${id}.${timestamp}.${body}`;
  const secretBytes = base64ToBytes(secret.replace(/^whsec_/, ""));
  const key = await crypto.subtle.importKey("raw", secretBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sigBytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  const signature = `v1,${bytesToBase64(new Uint8Array(sigBytes))}`;
  return new Request("https://test.workers.dev/webhooks/dodo", {
    method: "POST",
    headers: {
      "webhook-id": id,
      "webhook-timestamp": timestamp,
      "webhook-signature": signature,
      "Content-Type": "application/json",
    },
    body,
  });
}

function base64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToBase64(b: Uint8Array): string {
  let s = ""; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}

const sampleActivationEvent: DodoSubscriptionEvent = {
  type: "subscription.active",
  data: {
    subscription_id: "sub_abc123",
    customer: { customer_id: "cus_xyz", email: "buyer@example.com" },
    product_id: "pdt_team_yyy",
  },
};

describe("Dodo webhook handler", () => {
  it("rejects request without webhook headers", async () => {
    const r = await handleDodoWebhook(
      new Request("https://test/webhooks/dodo", { method: "POST", body: "{}" }),
      baseEnv as any
    );
    expect(r.status).toBe(400);
  });

  it("rejects request with invalid signature", async () => {
    const r1 = await signedRequest(sampleActivationEvent, "whsec_d3Jvbmctc2VjcmV0LWZvci10ZXN0aW5n");
    const r = await handleDodoWebhook(r1, baseEnv as any);
    expect(r.status).toBe(401);
  });

  it("rejects requests with timestamp outside 5-min replay window", async () => {
    const req = await signedRequest(sampleActivationEvent, WEBHOOK_SECRET, { skewMs: -10 * 60 * 1000 });
    const r = await handleDodoWebhook(req, baseEnv as any);
    expect(r.status).toBe(401);
  });

  it("mints an API key on subscription.active for known product", async () => {
    const req = await signedRequest(sampleActivationEvent);
    const r = await handleDodoWebhook(req, baseEnv as any);
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(body.ok).toBe(true);
    expect(body.apiKey_issued).toBe(true);

    // The key should be retrievable via the sub: index and resolve to team tier.
    const stored = (baseEnv.USAGE as any).store as Map<string, string>;
    const apiKey = stored.get("sub:sub_abc123");
    expect(apiKey).toBeDefined();
    expect(apiKey!.startsWith("mck_")).toBe(true);

    const resolved = await resolveKey(apiKey!, baseEnv.USAGE);
    expect(resolved.tier).toBe("team");
    expect(resolved.owner).toBe("buyer@example.com");
    expect(resolved.status).toBe("active");
  });

  it("rejects subscription.active with unknown product_id (422)", async () => {
    const ev = { ...sampleActivationEvent, data: { ...sampleActivationEvent.data, product_id: "pdt_does_not_exist" } };
    const req = await signedRequest(ev);
    const r = await handleDodoWebhook(req, baseEnv as any);
    expect(r.status).toBe(422);
  });

  it("is idempotent on subscription.active re-delivery (same key returned)", async () => {
    const req1 = await signedRequest(sampleActivationEvent);
    const res1 = await handleDodoWebhook(req1, baseEnv as any);
    const body1 = await res1.json() as any;
    expect(body1.apiKey_issued).toBe(true);

    const req2 = await signedRequest(sampleActivationEvent);
    const res2 = await handleDodoWebhook(req2, baseEnv as any);
    const body2 = await res2.json() as any;
    expect(body2.apiKey_issued).toBe(false);     // not minted again
  });

  it("flips status to cancelled on subscription.cancelled", async () => {
    // first activate
    await handleDodoWebhook(await signedRequest(sampleActivationEvent), baseEnv as any);
    const cancelEv: DodoSubscriptionEvent = { type: "subscription.cancelled", data: { ...sampleActivationEvent.data } };
    const r = await handleDodoWebhook(await signedRequest(cancelEv), baseEnv as any);
    expect(r.status).toBe(200);

    const apiKey = (baseEnv.USAGE as any).store.get("sub:sub_abc123") as string;
    const rec = await baseEnv.USAGE.get<{ status: string }>(`key:${apiKey}`, "json");
    expect(rec?.status).toBe("cancelled");
  });

  it("flips status to past_due on payment.failed", async () => {
    await handleDodoWebhook(await signedRequest(sampleActivationEvent), baseEnv as any);
    const failEv: DodoSubscriptionEvent = { type: "payment.failed", data: { ...sampleActivationEvent.data } };
    const r = await handleDodoWebhook(await signedRequest(failEv), baseEnv as any);
    expect(r.status).toBe(200);

    const apiKey = (baseEnv.USAGE as any).store.get("sub:sub_abc123") as string;
    const rec = await baseEnv.USAGE.get<{ status: string }>(`key:${apiKey}`, "json");
    expect(rec?.status).toBe("past_due");
  });

  it("no-ops on payment.succeeded standalone event", async () => {
    const ev: DodoSubscriptionEvent = { type: "payment.succeeded", data: { customer: { customer_id: "c1", email: "x@y" } } };
    const r = await handleDodoWebhook(await signedRequest(ev), baseEnv as any);
    expect(r.status).toBe(200);
  });

  it("resolves cancelled keys to free tier after their monthlyResetAt", async () => {
    // Manually inject a cancelled key with a reset date in the past.
    const apiKey = "mck_testkey";
    await baseEnv.USAGE.put(
      `key:${apiKey}`,
      JSON.stringify({
        tier: "team", owner: "x@y", createdAt: Date.now() - 30 * 86400_000,
        monthlyResetAt: Date.now() - 1000, status: "cancelled",
      })
    );
    const r = await resolveKey(apiKey, baseEnv.USAGE);
    expect(r.tier).toBe("free");
    expect(r.owner).toBe("x@y");
  });
});
