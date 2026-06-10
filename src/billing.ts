// Vendored from products/_template/src/billing.ts. Keep these two files in sync.
// (In production this is moved to a private repo; see ../../README.md.)

import { Tier, TIER_LIMITS, monthKey } from "./auth";

export interface QuotaResult {
  allowed: boolean;
  callsRemaining: number;
  resetAt: number;
  reason?: "monthly_exceeded" | "rate_exceeded";
}

export async function checkAndIncrement(
  apiKey: string | null,
  tier: Tier,
  usage: KVNamespace
): Promise<QuotaResult> {
  const keyId = apiKey ?? `anon:${new Date().toISOString().slice(0, 10)}`;
  const { monthlyCalls, ratePerMin } = TIER_LIMITS[tier];
  const monthBucket = monthKey();
  const monthlyKvKey = `counter:${keyId}:${monthBucket}`;
  const currentMonthly = parseInt((await usage.get(monthlyKvKey)) || "0", 10);
  if (currentMonthly >= monthlyCalls) {
    return { allowed: false, callsRemaining: 0, resetAt: startOfNextMonth().getTime(), reason: "monthly_exceeded" };
  }
  const minuteBucket = Math.floor(Date.now() / 60_000);
  const rateKvKey = `rate:${keyId}:${minuteBucket}`;
  const currentRate = parseInt((await usage.get(rateKvKey)) || "0", 10);
  if (currentRate >= ratePerMin) {
    return { allowed: false, callsRemaining: monthlyCalls - currentMonthly, resetAt: (minuteBucket + 1) * 60_000, reason: "rate_exceeded" };
  }
  await Promise.all([
    usage.put(monthlyKvKey, String(currentMonthly + 1), { expirationTtl: 60 * 60 * 24 * 35 }),
    usage.put(rateKvKey, String(currentRate + 1), { expirationTtl: 65 }),
  ]);
  return { allowed: true, callsRemaining: monthlyCalls - currentMonthly - 1, resetAt: startOfNextMonth().getTime() };
}

export function quotaErrorResponse(q: QuotaResult, upgradeUrl: string): Response {
  const message = q.reason === "rate_exceeded"
    ? "Rate limit exceeded; please slow down or upgrade for higher rate limits."
    : "Monthly call quota exceeded; please upgrade to continue.";
  return new Response(
    JSON.stringify({ error: q.reason, message, callsRemaining: q.callsRemaining, resetAt: q.resetAt, upgradeUrl }),
    { status: 429, headers: { "Content-Type": "application/json", "Retry-After": String(Math.max(1, Math.floor((q.resetAt - Date.now()) / 1000))) } }
  );
}

function startOfNextMonth(now = Date.now()): Date {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 0, 0, 0, 0));
}
