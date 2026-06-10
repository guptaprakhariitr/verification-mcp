// Verification client — wraps Wikipedia / Wikidata / Crossref / Wayback Machine.
// All upstream APIs are free with no key required.

import { KvCache, stableKey } from "./cache";

export interface VerifierEnv {
  CACHE: KVNamespace;
  WIKIPEDIA_BASE: string;        // https://en.wikipedia.org/api/rest_v1
  WIKIDATA_BASE: string;         // https://query.wikidata.org
  CROSSREF_BASE: string;         // https://api.crossref.org
  WAYBACK_BASE: string;          // https://archive.org/wayback
  USER_AGENT: string;            // contact email required for polite API use
}

export interface FactCheckResult {
  claim: string;
  verdict: "supported" | "contradicted" | "unverified" | "mixed";
  confidence: number;                 // 0..1
  sources: Array<{ name: string; url: string; excerpt?: string; supports: boolean }>;
  notes?: string;
}

export interface CiteCheckEntry {
  url: string;
  reachable: boolean;
  http_status?: number;
  retracted?: boolean;
  retraction_url?: string;
  is_doi?: boolean;
  doi_canonical?: string;
  match_score?: number;               // 0..1 — how well the page content matches the cited claim
}

export interface FreshnessResult {
  url: string;
  last_modified?: string;             // HTTP Last-Modified, if present
  wayback_snapshots: Array<{ timestamp: string; url: string }>;
  changed_recently: boolean;          // true if site modified in last 90 days OR snapshot diff > threshold
  source_status: number;
}

const POLITE_HEADERS = (ua: string) => ({
  "User-Agent": ua,
  "Accept": "application/json",
});

export class VerifierClient {
  private cache: KvCache;
  constructor(private env: VerifierEnv) { this.cache = new KvCache(env.CACHE, "verify"); }

  // ── fact_check ────────────────────────────────────────────────────────────

  async factCheck(claim: string): Promise<FactCheckResult> {
    const key = `fact:${stableKey({ claim: claim.slice(0, 200).toLowerCase() })}`;
    return this.cache.memoize(key, 60 * 60 * 6, async () => {
      // 1) Wikipedia OpenSearch + summary
      const wikis = await this.wikipediaLookup(claim);
      // 2) Wikidata entity search (currently used for entity name disambiguation)
      const wd = await this.wikidataLookup(claim);
      // 3) Crossref work search (covers academic-claim verification)
      const cr = await this.crossrefLookup(claim);

      const sources = [
        ...wikis.map((w) => ({ name: "Wikipedia", url: w.url, excerpt: w.extract, supports: w.matchScore >= 0.4 })),
        ...wd.map((d) => ({ name: "Wikidata", url: d.url, excerpt: d.label, supports: d.matchScore >= 0.4 })),
        ...cr.map((c) => ({ name: "Crossref", url: c.url, excerpt: c.title, supports: c.matchScore >= 0.4 })),
      ];
      const supportingCount = sources.filter((s) => s.supports).length;
      const totalEvidence = sources.length;
      let verdict: FactCheckResult["verdict"];
      let confidence: number;
      if (totalEvidence === 0) {
        verdict = "unverified";
        confidence = 0;
      } else if (supportingCount === totalEvidence) {
        verdict = "supported";
        confidence = Math.min(0.95, 0.5 + supportingCount * 0.1);
      } else if (supportingCount === 0) {
        verdict = "contradicted";
        confidence = Math.min(0.85, 0.4 + totalEvidence * 0.1);
      } else {
        verdict = "mixed";
        confidence = 0.3 + supportingCount / (totalEvidence + 1);
      }
      return {
        claim,
        verdict,
        confidence: Number(confidence.toFixed(2)),
        sources: sources.slice(0, 10),
        notes: verdict === "unverified" ? "No authoritative sources matched. The claim may be too specific or the entity not yet on Wikipedia/Wikidata/Crossref." : undefined,
      };
    });
  }

  // ── cite_check ────────────────────────────────────────────────────────────

  async citeCheckBatch(items: Array<{ url: string; claim?: string }>): Promise<CiteCheckEntry[]> {
    const out = await Promise.all(items.slice(0, 25).map((it) => this.citeCheckOne(it.url, it.claim)));
    return out;
  }

  async citeCheckOne(url: string, claim?: string): Promise<CiteCheckEntry> {
    const key = `cite:${stableKey({ url, claim: claim?.slice(0, 200) ?? "" })}`;
    return this.cache.memoize(key, 60 * 60, async () => {
      const isDoi = /^10\.\d{4,}\//.test(url) || /doi\.org/.test(url);
      let canonical: string | undefined;
      let retracted = false;
      let retraction_url: string | undefined;

      if (isDoi) {
        const doi = url.replace(/^https?:\/\/(dx\.)?doi\.org\//, "");
        const cr = await this.crossrefByDoi(doi);
        if (cr) {
          canonical = `https://doi.org/${doi}`;
          // Retraction-Watch metadata appears under the `update-to` field on Crossref.
          retracted = !!(cr["update-to"] || []).some((u: any) => /retract/i.test(u.type ?? ""));
          if (retracted) retraction_url = canonical;
        }
      }

      // HEAD or GET to check reachability + match score.
      let http_status: number | undefined;
      let match_score: number | undefined;
      try {
        const r = await fetch(url, { method: "GET", headers: POLITE_HEADERS(this.env.USER_AGENT), redirect: "follow" });
        http_status = r.status;
        if (claim && r.ok) {
          const body = (await r.text()).slice(0, 50_000);
          match_score = jaccardSimilarity(tokenize(claim), tokenize(stripHtml(body)));
        }
      } catch {
        http_status = 0;
      }

      return {
        url,
        reachable: !!(http_status && http_status >= 200 && http_status < 400),
        http_status,
        retracted,
        retraction_url,
        is_doi: isDoi,
        doi_canonical: canonical,
        match_score,
      };
    });
  }

  // ── source_freshness ──────────────────────────────────────────────────────

  async sourceFreshness(url: string): Promise<FreshnessResult> {
    const key = `fresh:${stableKey({ url })}`;
    return this.cache.memoize(key, 60 * 30, async () => {
      let last_modified: string | undefined;
      let source_status = 0;
      try {
        const r = await fetch(url, { method: "HEAD", headers: POLITE_HEADERS(this.env.USER_AGENT), redirect: "follow" });
        source_status = r.status;
        last_modified = r.headers.get("Last-Modified") ?? undefined;
      } catch { /* source_status stays 0 */ }

      // Wayback Machine snapshots — fetch up to 5 most recent.
      const snapshots: Array<{ timestamp: string; url: string }> = [];
      try {
        const r = await fetch(`${this.env.WAYBACK_BASE}/available?url=${encodeURIComponent(url)}`, { headers: POLITE_HEADERS(this.env.USER_AGENT) });
        if (r.ok) {
          const j: any = await r.json();
          const closest = j?.archived_snapshots?.closest;
          if (closest?.url) snapshots.push({ timestamp: closest.timestamp, url: closest.url });
        }
      } catch { /* keep empty */ }

      // Heuristic: "changed_recently" if Last-Modified is within the last 90 days.
      let changed_recently = false;
      if (last_modified) {
        const t = Date.parse(last_modified);
        if (!isNaN(t)) changed_recently = Date.now() - t < 90 * 24 * 60 * 60 * 1000;
      }
      return { url, last_modified, wayback_snapshots: snapshots, changed_recently, source_status };
    });
  }

  // ── upstreams ─────────────────────────────────────────────────────────────

  private async wikipediaLookup(claim: string): Promise<Array<{ url: string; extract: string; matchScore: number }>> {
    const q = encodeURIComponent(claim.slice(0, 200));
    try {
      const sr = await fetch(`${this.env.WIKIPEDIA_BASE}/page/search?q=${q}&limit=3`, { headers: POLITE_HEADERS(this.env.USER_AGENT) });
      if (!sr.ok) return [];
      const sj: any = await sr.json();
      const pages = (sj?.pages ?? []).slice(0, 3);
      return pages.map((p: any) => ({
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(p.key)}`,
        extract: p.description || p.excerpt || "",
        matchScore: jaccardSimilarity(tokenize(claim), tokenize(`${p.title} ${p.description ?? ""} ${p.excerpt ?? ""}`)),
      }));
    } catch { return []; }
  }

  private async wikidataLookup(claim: string): Promise<Array<{ url: string; label: string; matchScore: number }>> {
    try {
      const sr = await fetch(`https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&language=en&limit=3&search=${encodeURIComponent(claim.slice(0, 100))}`, {
        headers: POLITE_HEADERS(this.env.USER_AGENT),
      });
      if (!sr.ok) return [];
      const sj: any = await sr.json();
      const entities = (sj?.search ?? []).slice(0, 3);
      return entities.map((e: any) => ({
        url: e.concepturi || `https://www.wikidata.org/wiki/${e.id}`,
        label: `${e.label}: ${e.description ?? ""}`,
        matchScore: jaccardSimilarity(tokenize(claim), tokenize(`${e.label} ${e.description ?? ""}`)),
      }));
    } catch { return []; }
  }

  private async crossrefLookup(claim: string): Promise<Array<{ url: string; title: string; matchScore: number }>> {
    try {
      const sr = await fetch(`${this.env.CROSSREF_BASE}/works?query=${encodeURIComponent(claim.slice(0, 200))}&rows=3`, {
        headers: POLITE_HEADERS(this.env.USER_AGENT),
      });
      if (!sr.ok) return [];
      const sj: any = await sr.json();
      const works = (sj?.message?.items ?? []).slice(0, 3);
      return works.map((w: any) => ({
        url: w.URL || `https://doi.org/${w.DOI}`,
        title: (w.title ?? [""])[0],
        matchScore: jaccardSimilarity(tokenize(claim), tokenize(`${(w.title ?? [""])[0]} ${(w.abstract ?? "")}`)),
      }));
    } catch { return []; }
  }

  private async crossrefByDoi(doi: string): Promise<any | null> {
    try {
      // Crossref accepts the raw DOI path (`/works/10.x/y`); URL-encoding the
      // slash separator (`%2F`) works too, but the raw form keeps URLs human-
      // readable in logs.
      const r = await fetch(`${this.env.CROSSREF_BASE}/works/${doi}`, { headers: POLITE_HEADERS(this.env.USER_AGENT) });
      if (!r.ok) return null;
      const j: any = await r.json();
      return j?.message ?? null;
    } catch { return null; }
  }
}

// ── helpers (exported for tests) ────────────────────────────────────────────

export function tokenize(s: string): Set<string> {
  return new Set(
    s.toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
  );
}

export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  const inter = [...a].filter((x) => b.has(x)).length;
  const union = new Set([...a, ...b]).size;
  return Number((inter / union).toFixed(3));
}

export function stripHtml(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/gi, " ")
             .replace(/<style[\s\S]*?<\/style>/gi, " ")
             .replace(/<[^>]+>/g, " ")
             .replace(/\s+/g, " ");
}

const STOP_WORDS = new Set([
  "the", "and", "for", "but", "with", "that", "this", "from", "have", "has",
  "had", "are", "was", "were", "you", "your", "they", "their", "what", "when",
  "who", "where", "why", "how", "which", "will", "would", "should", "could",
  "more", "than", "into", "over", "between", "about", "after", "before",
]);
