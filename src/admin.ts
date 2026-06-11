// Operator-only admin endpoints — read KV for fan-out aggregation by mcp-hub.
// Vendored identically into every Category-1 product. The mcp-hub `/admin/*`
// dashboard calls these via service bindings using a shared ADMIN_TOKEN secret.
//
// Routes mounted in src/index.ts:
//   GET /admin/list-keys     → JSON list of every KV key:<apikey> record
//   GET /admin/list-support  → JSON list of support tickets
//   GET /admin/list-events   → JSON list of recent webhook events
//
// All gated by `Authorization: Bearer <ADMIN_TOKEN>`. ADMIN_TOKEN must be set
// as a Worker secret (NOT in [vars]) on every product + mcp-hub. The hub's
// fan-out uses the SAME token across all bindings so one secret rules them all.

import { KeyRecord, TeamMemberRecord } from "./auth";

export interface AdminEnv {
  USAGE: KVNamespace;
  ADMIN_TOKEN?: string;
  PRODUCT_NAME?: string;
}

export function isAdminAuthed(request: Request, env: AdminEnv): boolean {
  if (!env.ADMIN_TOKEN) return false;
  const auth = request.headers.get("Authorization") || request.headers.get("authorization") || "";
  const m = auth.match(/^Bearer\s+(\S+)$/i);
  if (!m) return false;
  // Constant-time compare to avoid timing leaks.
  return ctEqual(m[1], env.ADMIN_TOKEN);
}

export function adminUnauthorized(): Response {
  return new Response(JSON.stringify({ error: "Unauthorized" }), {
    status: 401,
    headers: { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" },
  });
}

/** GET /admin/list-keys — list every API key + tier + email + signup date. */
export async function handleAdminListKeys(request: Request, env: AdminEnv): Promise<Response> {
  if (!isAdminAuthed(request, env)) return adminUnauthorized();
  const owners = await listByPrefixJson<KeyRecord>(env.USAGE, "key:");
  const teamMembers = await listByPrefixJson<TeamMemberRecord>(env.USAGE, "team-member:");
  const product = env.PRODUCT_NAME ?? "unknown";
  return jsonOk({
    product,
    listed_at: new Date().toISOString(),
    owner_count: owners.length,
    team_member_count: teamMembers.length,
    owners: owners.map((o) => ({
      api_key: o.name.slice("key:".length),
      tier: o.value.tier,
      email: o.value.owner,
      status: o.value.status,
      created_at: new Date(o.value.createdAt).toISOString(),
      customer_id: o.value.customerId ?? null,
      subscription_id: o.value.subscriptionId ?? null,
    })),
    team_members: teamMembers.map((m) => ({
      sub_api_key: m.name.slice("team-member:".length),
      owner_api_key: m.value.owner_api_key,
      email: m.value.member_email,
      label: m.value.label ?? null,
      created_at: new Date(m.value.created_at).toISOString(),
    })),
  });
}

/** GET /admin/list-support — list all support tickets in KV. */
export async function handleAdminListSupport(request: Request, env: AdminEnv): Promise<Response> {
  if (!isAdminAuthed(request, env)) return adminUnauthorized();
  const tickets = await listByPrefixJson<SupportTicket>(env.USAGE, "support:");
  const product = env.PRODUCT_NAME ?? "unknown";
  // Newest first.
  tickets.sort((a, b) => (b.value.created_at || "").localeCompare(a.value.created_at || ""));
  return jsonOk({
    product,
    listed_at: new Date().toISOString(),
    count: tickets.length,
    tickets: tickets.map((t) => ({
      ticket_id: t.value.ticket_id,
      product,
      name: t.value.name,
      email: t.value.email,
      subject: t.value.subject,
      message: t.value.message,
      created_at: t.value.created_at,
    })),
  });
}

/** GET /admin/list-events — list all webhook events recorded under event:<apikey>:* */
export async function handleAdminListEvents(request: Request, env: AdminEnv): Promise<Response> {
  if (!isAdminAuthed(request, env)) return adminUnauthorized();
  const events = await listByPrefixJson<StoredEvent>(env.USAGE, "event:");
  const product = env.PRODUCT_NAME ?? "unknown";
  events.sort((a, b) => (b.value.at || "").localeCompare(a.value.at || ""));
  return jsonOk({
    product,
    listed_at: new Date().toISOString(),
    count: events.length,
    events: events.slice(0, 500).map((e) => {
      // KV key: event:<apikey>:<rest>
      const rest = e.name.slice("event:".length);
      const idx = rest.indexOf(":");
      const apiKey = idx < 0 ? rest : rest.slice(0, idx);
      return {
        product,
        api_key_hint: apiKey.slice(0, 12) + "…",
        type: e.value.type,
        at: e.value.at,
        data: e.value.data ?? null,
      };
    }),
  });
}

interface SupportTicket {
  ticket_id: string;
  name: string;
  email: string;
  subject: string;
  message: string;
  product_slug?: string;
  created_at: string;
}

interface StoredEvent {
  type: string;
  at: string;
  data?: Record<string, unknown>;
}

async function listByPrefixJson<T>(
  usage: KVNamespace,
  prefix: string
): Promise<Array<{ name: string; value: T }>> {
  const out: Array<{ name: string; value: T }> = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await usage.list({ prefix, limit: 1000, cursor });
    for (const k of page.keys) {
      // Skip namespaced sub-prefixes we don't want when prefix is short.
      // counter:<apikey>:<month> shares the "key:" prefix? No — "counter:" not "key:". Safe.
      const v = await usage.get<T>(k.name, "json");
      if (v) out.push({ name: k.name, value: v });
    }
    if (page.list_complete || !page.cursor) break;
    cursor = page.cursor;
  }
  return out;
}

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function ctEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
