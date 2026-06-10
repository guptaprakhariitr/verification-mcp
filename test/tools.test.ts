import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VerifierClient, tokenize, jaccardSimilarity, stripHtml } from "../src/verifier";
import { McpServer, ToolContext } from "../src/mcp-server";
import { buildTools } from "../src/tools";

class FakeKv {
  store = new Map<string, string>();
  async get(key: string, type?: "text" | "json"): Promise<any> {
    const v = this.store.get(key); if (v === undefined) return null;
    if (type === "json") return JSON.parse(v); return v;
  }
  async put(key: string, value: string): Promise<void> { this.store.set(key, value); }
  async delete(key: string): Promise<void> { this.store.delete(key); }
}

const env = {
  CACHE: new FakeKv() as unknown as KVNamespace,
  USAGE: new FakeKv() as unknown as KVNamespace,
  WIKIPEDIA_BASE: "https://en.wikipedia.org/api/rest_v1",
  WIKIDATA_BASE: "https://query.wikidata.org",
  CROSSREF_BASE: "https://api.crossref.org",
  WAYBACK_BASE: "https://archive.org/wayback",
  USER_AGENT: "test/0.1 (test@example.com)",
  UPGRADE_URL: "x",
};

beforeEach(() => {
  (env.CACHE as any).store = new Map();
  vi.stubGlobal("fetch", async (url: string | URL, _init?: RequestInit) => {
    const u = typeof url === "string" ? url : url.toString();
    if (u.includes("/page/search")) {
      return new Response(JSON.stringify({
        pages: [
          { key: "Microsoft", title: "Microsoft", description: "American multinational technology corporation founded by Bill Gates and Paul Allen on April 4, 1975.", excerpt: "Microsoft was founded in 1975." },
        ],
      }), { status: 200 });
    }
    if (u.includes("wbsearchentities")) {
      return new Response(JSON.stringify({ search: [{ id: "Q2283", label: "Microsoft", description: "American multinational technology company founded 1975", concepturi: "http://www.wikidata.org/entity/Q2283" }] }), { status: 200 });
    }
    if (u.includes("/works?query=")) {
      return new Response(JSON.stringify({ message: { items: [{ DOI: "10.1234/abc", URL: "https://doi.org/10.1234/abc", title: ["History of Microsoft"], abstract: "" }] } }), { status: 200 });
    }
    if (u.includes("/works/10.1234/retracted")) {
      return new Response(JSON.stringify({ message: { "update-to": [{ type: "retraction" }] } }), { status: 200 });
    }
    if (u.includes("/works/10.1234/clean")) {
      return new Response(JSON.stringify({ message: { title: ["A real paper"] } }), { status: 200 });
    }
    if (u.startsWith("https://archive.org/wayback/available")) {
      return new Response(JSON.stringify({ archived_snapshots: { closest: { timestamp: "20240101000000", url: "https://web.archive.org/web/20240101000000/https://example.com" } } }), { status: 200 });
    }
    if (u.startsWith("https://example.com/article")) {
      // Used by cite_check + source_freshness on a sample URL.
      return new Response("<html><body><h1>Microsoft</h1><p>Microsoft was founded in 1975 by Bill Gates and Paul Allen.</p></body></html>", {
        status: 200,
        headers: { "Last-Modified": new Date().toUTCString() },
      });
    }
    if (u.startsWith("https://example.com/dead")) {
      return new Response("not found", { status: 404 });
    }
    return new Response("{}", { status: 200 });
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("Helpers", () => {
  it("tokenize strips stop words + short tokens", () => {
    const t = tokenize("The quick brown fox jumps over the lazy dog");
    expect(t.has("the")).toBe(false);
    expect(t.has("quick")).toBe(true);
    expect(t.has("brown")).toBe(true);
  });
  it("jaccard returns 1 on identical sets", () => {
    expect(jaccardSimilarity(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(1);
  });
  it("jaccard returns 0 on disjoint sets", () => {
    expect(jaccardSimilarity(new Set(["a"]), new Set(["b"]))).toBe(0);
  });
  it("stripHtml removes tags + scripts", () => {
    expect(stripHtml("<p>Hi <script>alert(1)</script> there</p>")).toMatch(/Hi\s+there/);
  });
});

describe("fact_check", () => {
  it("returns 'supported' for a well-attested claim", async () => {
    const c = new VerifierClient(env as any);
    const r = await c.factCheck("Microsoft was founded in 1975 by Bill Gates");
    expect(["supported", "mixed"]).toContain(r.verdict);
    expect(r.sources.length).toBeGreaterThan(0);
    expect(r.sources.some((s) => s.name === "Wikipedia")).toBe(true);
  });
});

describe("cite_check", () => {
  it("flags reachable URL with claim match", async () => {
    const c = new VerifierClient(env as any);
    const out = await c.citeCheckBatch([{ url: "https://example.com/article", claim: "Microsoft founded 1975 Bill Gates" }]);
    expect(out[0].reachable).toBe(true);
    expect(out[0].http_status).toBe(200);
    expect(out[0].match_score).toBeGreaterThan(0);
  });
  it("flags unreachable URL", async () => {
    const c = new VerifierClient(env as any);
    const out = await c.citeCheckBatch([{ url: "https://example.com/dead" }]);
    expect(out[0].reachable).toBe(false);
    expect(out[0].http_status).toBe(404);
  });
  it("recognizes DOI format", async () => {
    const c = new VerifierClient(env as any);
    const out = await c.citeCheckBatch([{ url: "https://doi.org/10.1234/clean" }]);
    expect(out[0].is_doi).toBe(true);
    expect(out[0].doi_canonical).toBe("https://doi.org/10.1234/clean");
    expect(out[0].retracted).toBe(false);
  });
  it("flags retracted DOIs", async () => {
    const c = new VerifierClient(env as any);
    const out = await c.citeCheckBatch([{ url: "https://doi.org/10.1234/retracted" }]);
    expect(out[0].retracted).toBe(true);
  });
});

describe("source_freshness", () => {
  it("returns 'changed_recently=true' for fresh Last-Modified", async () => {
    const c = new VerifierClient(env as any);
    const r = await c.sourceFreshness("https://example.com/article");
    expect(r.source_status).toBe(200);
    expect(r.changed_recently).toBe(true);
    expect(r.last_modified).toBeDefined();
    expect(r.wayback_snapshots.length).toBeGreaterThan(0);
  });
});

describe("MCP protocol", () => {
  const server = new McpServer({ name: "verification-mcp", version: "0.1.0" });
  for (const t of buildTools()) server.register(t);
  const ctx: ToolContext = { env: env as any, apiKey: null, tier: "free", callsRemaining: 50 };

  it("lists all 3 tools (none premium)", async () => {
    const r = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" }, ctx);
    const names = (r!.result as any).tools.map((t: any) => t.name) as string[];
    expect(names).toEqual(["fact_check", "cite_check", "source_freshness"]);
  });
  it("fact_check end-to-end", async () => {
    const r = await server.handle(
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "fact_check", arguments: { claim: "Microsoft founded 1975 Bill Gates" } } }, ctx
    );
    const out = JSON.parse((r!.result as any).content[0].text);
    expect(out.verdict).toBeDefined();
    expect(out.sources.length).toBeGreaterThan(0);
  });
});
