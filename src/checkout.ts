// Checkout entry points — `/upgrade` and `/account` routes.
// Vendored identically into every Category-1 product.

import { DodoClient, DodoEnv } from "./dodo";
import { Tier, extractBearer, resolveKey } from "./auth";

export interface CheckoutEnv extends DodoEnv {
  USAGE: KVNamespace;
}

/**
 * GET /upgrade?tier=solo&email=...&return_to=...
 * → 302 to a Dodo hosted payment link for the selected tier.
 */
export async function handleUpgrade(request: Request, env: CheckoutEnv, returnUrlBase: string): Promise<Response> {
  const url = new URL(request.url);
  const tier = (url.searchParams.get("tier") ?? "solo") as Tier;
  if (tier !== "solo" && tier !== "team" && tier !== "pro") {
    return new Response("Invalid tier; one of solo, team, pro", { status: 400 });
  }
  const customer_email = url.searchParams.get("email") ?? undefined;
  const return_to = url.searchParams.get("return_to") ?? `${returnUrlBase}/account?paid=1`;

  const dodo = new DodoClient(env);
  try {
    const link = await dodo.createCheckoutLink({
      tier: tier as "solo" | "team" | "pro",
      customer_email,
      success_url: return_to,
      metadata: { source: "upgrade-link" },
    });
    return Response.redirect(link.payment_link, 302);
  } catch (err) {
    return new Response(`Checkout error: ${err instanceof Error ? err.message : String(err)}`, { status: 502 });
  }
}

/**
 * GET /account
 * → Returns the caller's key record and a customer-portal link.
 * Requires Authorization: Bearer <key>.
 */
export async function handleAccount(request: Request, env: CheckoutEnv): Promise<Response> {
  const apiKey = extractBearer(request);
  if (!apiKey) return json({ error: "Missing Authorization header" }, 401);
  const { tier, owner, status } = await resolveKey(apiKey, env.USAGE);
  if (status === "anonymous") return json({ error: "Unknown API key" }, 404);

  // Look up the subscription id for the customer-portal link.
  const rec = await env.USAGE.get<{ subscriptionId?: string; customerId?: string }>(`key:${apiKey}`, "json");
  let portal_url: string | null = null;
  if (rec?.customerId) {
    try {
      const dodo = new DodoClient(env);
      portal_url = (await dodo.createCustomerPortalLink(rec.customerId)).portal_url || null;
    } catch (err) {
      console.error("portal link failed:", err);
    }
  }
  return json({ apiKey, tier, owner, status, portal_url });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
