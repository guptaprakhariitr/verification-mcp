# verification-mcp

> Real-time **fact-checking + citation verification + source-freshness** for AI agents. Tools an agent can call mid-reasoning to ground its claims against authoritative free sources (Wikipedia, Wikidata, Crossref, Wayback Machine).

**Endpoint:** `https://verification-mcp.prakhar-cognizance.workers.dev/mcp`

## What it does

The single biggest empty quadrant in the AI-agent tooling space (per 2026 ecosystem research): nobody runs a cheap, hosted, agent-callable verifier. Existing options (Vectara, Patronus, Galileo) are enterprise-priced and aimed at builders, not run-time.

This MCP lets an agent run three operations during reasoning:

| Tool | What it does |
|---|---|
| `fact_check(claim)` | Searches Wikipedia + Wikidata + Crossref for the claim. Returns verdict (`supported` / `contradicted` / `mixed` / `unverified`), 0–1 confidence, source list with excerpts. |
| `cite_check(citations[])` | For each `{url, claim?}` (up to 25): checks the URL resolves, computes Jaccard match between the page content and the claim, surfaces retraction status (Crossref `update-to`). |
| `source_freshness(url)` | HTTP `Last-Modified` + most recent Wayback Machine snapshot + boolean `changed_recently` (last 90 days). Useful for RAG hygiene. |

## Install

```json
// Cursor / Claude Desktop / Cline
{
  "mcpServers": {
    "verification": {
      "url": "https://verification-mcp.prakhar-cognizance.workers.dev/mcp",
      "headers": { "Authorization": "Bearer YOUR_KEY" }
    }
  }
}
```

Free tier: send requests without an `Authorization` header. 50 calls/month, 10/min.

## Pricing

| Tier | Price | Monthly calls | Notes |
|---|---|---|---|
| Free | $0 | 50 | 10/min ceiling. Anonymous. |
| **Solo** | **$19/mo** | 1,000 | 60/min ceiling. |
| **Team** | **$49/mo** | 5,000 | 200/min, all tools. |
| **Pro** | **$149/mo** | 20,000 | 600/min, all tools, priority routing. |

Higher than Cat-1 data MCPs because each verification call fans out to multiple upstream sources (typically 3–5 HTTP requests per `fact_check`).

[Upgrade →](https://verification-mcp.prakhar-cognizance.workers.dev/upgrade?tier=solo)

## How it works

```
fact_check("Microsoft was founded in 1975")
        │
        ▼
  ┌──────────────────────────────────────────────┐
  │ Cloudflare Worker (verification-mcp)         │
  │                                              │
  │  Parallel fetch:                             │
  │    Wikipedia REST  /page/search?q=…          │
  │    Wikidata        /w/api.php?wbsearch…      │
  │    Crossref        /works?query=…            │
  │  ↓                                           │
  │  Jaccard token-overlap match against claim   │
  │  ↓                                           │
  │  Verdict aggregation                         │
  │  ↓                                           │
  │  KV cache (6h TTL)                           │
  └──────────────────────────────────────────────┘
        │
        ▼
  { verdict: "supported", confidence: 0.80, sources: [{Wikipedia: "Microsoft was founded by Bill Gates and Paul Allen on April 4, 1975."}, …] }
```

## License

MIT. Upstream data is free per each provider's terms of use (Wikipedia CC-BY-SA, Wikidata CC0, Crossref free, Wayback Machine free).

## See also

- [`docs/TOOLS.md`](docs/TOOLS.md) — per-tool reference for agents
- [`docs/LISTINGS.md`](docs/LISTINGS.md) — registry submission checklist
- [`CHANGELOG.md`](CHANGELOG.md) — release history


---

## Sister MCPs

All from the same operator, all live on `<product>.prakhar-cognizance.workers.dev`, all free-tier friendly:

| Group | Products |
|---|---|
| **Research** | [sec-edgar](https://github.com/guptaprakhariitr/sec-edgar-mcp) · [arxiv](https://github.com/guptaprakhariitr/arxiv-mcp) · [world-bank-economic](https://github.com/guptaprakhariitr/world-bank-economic-mcp) · [uspto-patents](https://github.com/guptaprakhariitr/uspto-patents-mcp) · [fda-approvals](https://github.com/guptaprakhariitr/fda-approvals-mcp) |
| **Verification + Utility** | [verification](https://github.com/guptaprakhariitr/verification-mcp) ⭐ · [unit-converter](https://github.com/guptaprakhariitr/unit-converter-mcp) |
| **India** | [indic-normalize](https://github.com/guptaprakhariitr/indic-normalize-mcp) · [indian-regulatory](https://github.com/guptaprakhariitr/indian-regulatory-mcp) |
| **Real-time** | [hn-trending](https://github.com/guptaprakhariitr/hn-trending-mcp) · [wikipedia-recent-changes](https://github.com/guptaprakhariitr/wikipedia-recent-changes-mcp) · [gdelt-events](https://github.com/guptaprakhariitr/gdelt-events-mcp) · [crypto-prices](https://github.com/guptaprakhariitr/crypto-prices-mcp) |
| **Healthcare** | [drug-interaction](https://github.com/guptaprakhariitr/drug-interaction-mcp) |
| **Logistics** | [multi-carrier-tracking](https://github.com/guptaprakhariitr/multi-carrier-tracking-mcp) |

Full catalog: https://github.com/guptaprakhariitr · ⭐ = empty-quadrant / highest-conviction pick.

