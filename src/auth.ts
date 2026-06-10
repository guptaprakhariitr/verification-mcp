// API-key auth + tier resolution + key issuance/revocation.
// Open-source; reused across every Category 1 product.
//
// Storage convention:
//   KV USAGE:  "key:<apikey>"                  -> KeyRecord { tier, owner, createdAt, monthlyResetAt, subscriptionId }
//   KV USAGE:  "sub:<subscription_id>"         -> apikey         (reverse lookup for webhooks)
//   KV USAGE:  "counter:<apikey>:<YYYY-MM>"    -> integer monthly call count
//   KV USAGE:  "rate:<apikey>:<minute-ts>"     -> integer per-minute count (60s TTL)
//   KV USAGE:  "team:<owner-apikey>"           -> TeamRecord { member_ids: string[] }  (sidecar; absent => no team members yet)
//   KV USAGE:  "team-member:<sub-apikey>"      -> TeamMemberRecord { owner_api_key, member_email, created_at, label }

export type Tier = "free" | "solo" | "team" | "pro";

export const TIER_LIMITS: Record<Tier, { monthlyCalls: number; ratePerMin: number }> = {
  free: { monthlyCalls: 100, ratePerMin: 10 },
  solo: { monthlyCalls: 2_000, ratePerMin: 60 },
  team: { monthlyCalls: 10_000, ratePerMin: 200 },
  pro:  { monthlyCalls: 50_000, ratePerMin: 600 },
};

export interface KeyRecord {
  tier: Tier;
  owner: string;                  // customer email
  customerId?: string;            // Dodo customer_id
  subscriptionId?: string;        // Dodo subscription_id
  createdAt: number;              // unix ms
  monthlyResetAt: number;         // unix ms
  status: "active" | "cancelled" | "past_due";
}

// Team-member sub-key record: stored at KV USAGE "team-member:<sub-apikey>".
// Looked up by the auth layer; quota/tier are inherited from the owner's KeyRecord.
export interface TeamMemberRecord {
  owner_api_key: string;          // the owner's "mck_*" key whose record drives tier+quota
  member_email: string;
  created_at: number;             // unix ms
  label?: string;                 // optional human label, e.g. "Bob from Eng"
}

// Sidecar list of team-member sub-keys an owner has issued.
// Kept separate from KeyRecord so older accounts continue to JSON-parse cleanly.
export interface TeamRecord {
  member_ids: string[];           // each entry IS the sub-API-key
}

// Per-tier seat allowances. Free / solo are locked out of the feature.
export const TEAM_SEAT_LIMITS: Record<Tier, number> = {
  free: 0,
  solo: 0,
  team: 5,
  pro: 25,
};

export function extractBearer(request: Request): string | null {
  const auth = request.headers.get("Authorization") || request.headers.get("authorization");
  if (!auth) return null;
  const match = auth.match(/^Bearer\s+(\S+)$/i);
  return match ? match[1] : null;
}

export interface ResolvedKey {
  tier: Tier;
  owner: string | null;
  status: KeyRecord["status"] | "anonymous";
  /**
   * Key to use for quota counters & rate limits. For a normal owner key this
   * equals the presented apiKey; for a team-member sub-key it is the OWNER's
   * key so all sub-key calls roll up against the parent's monthly quota.
   */
  effectiveKey: string | null;
  /** True when the presented key was looked up as a "team-member:" sub-key. */
  is_team_member?: boolean;
  /** When is_team_member, the sub-key (== member_id). Useful for audit logging. */
  member_id?: string;
}

export async function resolveKey(
  apiKey: string | null,
  usage: KVNamespace
): Promise<ResolvedKey> {
  if (!apiKey) return { tier: "free", owner: null, status: "anonymous", effectiveKey: null };

  // 1) Try owner key lookup first (most traffic).
  const rec = await usage.get<KeyRecord>(`key:${apiKey}`, "json");
  if (rec) {
    // A cancelled subscription downgrades to free at its monthlyResetAt.
    if (rec.status === "cancelled" && Date.now() >= rec.monthlyResetAt) {
      return { tier: "free", owner: rec.owner, status: rec.status, effectiveKey: apiKey };
    }
    return { tier: rec.tier, owner: rec.owner, status: rec.status, effectiveKey: apiKey };
  }

  // 2) Try team-member sub-key lookup. Quota + tier inherited from the owner.
  const member = await usage.get<TeamMemberRecord>(`team-member:${apiKey}`, "json");
  if (member) {
    const ownerRec = await usage.get<KeyRecord>(`key:${member.owner_api_key}`, "json");
    if (!ownerRec) {
      // Sub-key still around but owner record gone → treat as revoked / anonymous.
      return { tier: "free", owner: null, status: "anonymous", effectiveKey: null };
    }
    if (ownerRec.status === "cancelled" && Date.now() >= ownerRec.monthlyResetAt) {
      return {
        tier: "free",
        owner: ownerRec.owner,
        status: ownerRec.status,
        effectiveKey: member.owner_api_key,
        is_team_member: true,
        member_id: apiKey,
      };
    }
    return {
      tier: ownerRec.tier,
      owner: ownerRec.owner,
      status: ownerRec.status,
      effectiveKey: member.owner_api_key,
      is_team_member: true,
      member_id: apiKey,
    };
  }

  return { tier: "free", owner: null, status: "anonymous", effectiveKey: null };
}

export function monthKey(now = Date.now()): string {
  const d = new Date(now);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// ── Key issuance (called from the Dodo webhook handler) ──────────────────────

/** Generate a fresh API key. Format: `mck_` + 32 url-safe random bytes. */
export function generateApiKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return "mck_" + bytesToBase64Url(bytes);
}

export async function mintApiKey(opts: {
  usage: KVNamespace;
  tier: Tier;
  owner: string;
  customerId?: string;
  subscriptionId?: string;
}): Promise<string> {
  const apiKey = generateApiKey();
  const now = Date.now();
  const rec: KeyRecord = {
    tier: opts.tier,
    owner: opts.owner,
    customerId: opts.customerId,
    subscriptionId: opts.subscriptionId,
    createdAt: now,
    monthlyResetAt: startOfNextMonth(now).getTime(),
    status: "active",
  };
  await opts.usage.put(`key:${apiKey}`, JSON.stringify(rec));
  if (opts.subscriptionId) {
    await opts.usage.put(`sub:${opts.subscriptionId}`, apiKey);
  }
  return apiKey;
}

export async function updateKeyStatus(opts: {
  usage: KVNamespace;
  subscriptionId: string;
  status: KeyRecord["status"];
  newTier?: Tier;
}): Promise<{ apiKey: string; rec: KeyRecord } | null> {
  const apiKey = await opts.usage.get(`sub:${opts.subscriptionId}`);
  if (!apiKey) return null;
  const rec = await opts.usage.get<KeyRecord>(`key:${apiKey}`, "json");
  if (!rec) return null;
  rec.status = opts.status;
  if (opts.newTier) rec.tier = opts.newTier;
  // For "renewed" we extend the monthly reset; for "cancelled" we let the
  // current period run out then downgrade.
  if (opts.status === "active") {
    rec.monthlyResetAt = startOfNextMonth(Date.now()).getTime();
  }
  await opts.usage.put(`key:${apiKey}`, JSON.stringify(rec));
  return { apiKey, rec };
}

export async function getKeyBySubscription(
  usage: KVNamespace,
  subscriptionId: string
): Promise<{ apiKey: string; rec: KeyRecord } | null> {
  const apiKey = await usage.get(`sub:${subscriptionId}`);
  if (!apiKey) return null;
  const rec = await usage.get<KeyRecord>(`key:${apiKey}`, "json");
  if (!rec) return null;
  return { apiKey, rec };
}

function bytesToBase64Url(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function startOfNextMonth(now: number): Date {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 0, 0, 0, 0));
}
