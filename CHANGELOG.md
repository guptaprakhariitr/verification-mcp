# Changelog

## [0.1.0] — 2026-06-10

### Added
- Initial release. Three tools targeting the empty quadrant in the AI-agent ecosystem:
  - `fact_check` — verify a claim against Wikipedia + Wikidata + Crossref. Returns verdict + confidence + sources.
  - `cite_check` — batch-verify URL citations (resolves, retraction status, match score against claim).
  - `source_freshness` — last-modified + Wayback Machine snapshot + 'changed_recently' flag for RAG hygiene.
- KV-cached responses (6h for fact-checks, 1h for cite-checks, 30min for freshness).
- Standard Worker shim: Dodo Payments billing, free tier 50/mo, paid tiers $19/$49/$149/mo.

### Notes
- Fact-check confidence is heuristic — uses Jaccard token overlap as a proxy for semantic match against retrieved Wikipedia/Crossref entries. Production-grade NLI-based scoring would require an LLM call per check; that path is reserved for the Pro tier in a future release.
- All upstream APIs (Wikipedia REST, Wikidata wbsearchentities, Crossref works, archive.org/wayback/available) are free and key-less.
