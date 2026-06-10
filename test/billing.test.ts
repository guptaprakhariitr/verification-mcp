// Tests for the quota / billing layer.

import { beforeEach, describe, expect, it } from "vitest";
import { checkAndIncrement } from "../src/billing";
import { TIER_LIMITS } from "../src/auth";

class FakeKv {
  store = new Map<string, string>();
  async get(key: string) { return this.store.get(key) ?? null; }
  async put(key: string, value: string) { this.store.set(key, value); }
  async delete(key: string) { this.store.delete(key); }
}

describe("billing.checkAndIncrement", () => {
  let kv: FakeKv;
  beforeEach(() => { kv = new FakeKv(); });

  it("allows calls under the monthly limit", async () => {
    const r = await checkAndIncrement("test-key", "solo", kv as any);
    expect(r.allowed).toBe(true);
    expect(r.callsRemaining).toBe(TIER_LIMITS.solo.monthlyCalls - 1);
  });

  it("denies when monthly quota is exhausted", async () => {
    // pre-fill counter to the limit
    const monthBucket = new Date().toISOString().slice(0, 7);
    kv.store.set(`counter:test-key:${monthBucket}`, String(TIER_LIMITS.solo.monthlyCalls));
    const r = await checkAndIncrement("test-key", "solo", kv as any);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("monthly_exceeded");
  });

  it("denies when per-minute rate is exceeded", async () => {
    const minute = Math.floor(Date.now() / 60_000);
    kv.store.set(`rate:test-key:${minute}`, String(TIER_LIMITS.solo.ratePerMin));
    const r = await checkAndIncrement("test-key", "solo", kv as any);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("rate_exceeded");
  });

  it("treats absent api key as anonymous and tracks per-day", async () => {
    const r = await checkAndIncrement(null, "free", kv as any);
    expect(r.allowed).toBe(true);
    // the anon key includes today's date
    const today = new Date().toISOString().slice(0, 10);
    const keys = [...kv.store.keys()];
    expect(keys.some((k) => k.includes(`anon:${today}`))).toBe(true);
  });

  it("free tier has a smaller limit than solo", () => {
    expect(TIER_LIMITS.free.monthlyCalls).toBeLessThan(TIER_LIMITS.solo.monthlyCalls);
    expect(TIER_LIMITS.solo.monthlyCalls).toBeLessThan(TIER_LIMITS.team.monthlyCalls);
    expect(TIER_LIMITS.team.monthlyCalls).toBeLessThan(TIER_LIMITS.pro.monthlyCalls);
  });
});
