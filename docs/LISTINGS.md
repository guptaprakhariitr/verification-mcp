# Registry Submission Checklist

Pre-filled text + URLs for every MCP registry. Each takes 1–3 minutes in a browser.

## ✅ Already automatic

### Glama — `glama.ai`
Auto-crawls GitHub by repo topic `mcp-server`. Already tagged on this repo. Indexes within 24 hours.
- Check status: https://glama.ai/mcp/servers?q=sec-edgar
- No action needed.

### Official MCP Registry — `github.com/modelcontextprotocol/registry`
The canonical registry. Other registries (PulseMCP, mcp.so, etc.) ingest from here weekly.
The `server.json` file in this repo root is the registry manifest.
- **To submit:** in a fresh terminal:
  ```bash
  git clone https://github.com/modelcontextprotocol/registry.git
  cd registry
  make publisher
  ./bin/mcp-publisher login github                        # OAuth flow
  ./bin/mcp-publisher publish ../sec-edgar-mcp/server.json
  ```
- After this, ingestion ripples to all downstream registries.

## 🌐 Manual browser submission (1–3 min each)

### PulseMCP — `pulsemcp.com/submit`
Single-field form. They just want the GitHub URL.
- **URL:** https://www.pulsemcp.com/submit
- **Paste:** `https://github.com/guptaprakhariitr/sec-edgar-mcp`
- Review queue: typically 1–7 days.

### mcp.so — `mcp.so/submit`
Multi-field form. Use the values below.
- **URL:** https://mcp.so/submit
- **Name:** `sec-edgar-mcp`
- **Display name:** `SEC EDGAR`
- **Description (short):** `Real-time SEC EDGAR access for AI agents — filings search, 10-K/8-K reading, XBRL facts, Form 4 insider trades. Free underlying data, indie pricing from $9/mo.`
- **GitHub URL:** `https://github.com/guptaprakhariitr/sec-edgar-mcp`
- **Endpoint URL:** `https://sec-edgar-mcp.atlasword.workers.dev/mcp`
- **Category / tags:** finance, research, sec, edgar, xbrl
- **License:** MIT
- **Transport:** HTTP (remote)
- **Authentication:** Bearer (free tier requires no key)

### mcp.directory — `mcp.directory/submit`
Curated, manual review. Use the same values as mcp.so.
- **URL:** https://mcp.directory/submit
- Tip: include a working demo URL or a GIF — they prioritize listings with real demos.

### Smithery — `smithery.ai`
**Paid listing — $30/mo.** Worth it if you have ≥6 paid customers; not before.
- **URL:** https://smithery.ai/new
- Use the `smithery.json` file already in this repo root.
- Authentication is bearer; pricing tiers already in the manifest.

### Cursor Marketplace — `cursor.com/marketplace`
Curated. Application form.
- **URL:** Cursor Settings → Marketplace → Submit. (Login first.)
- Cursor reviews applications; budget 1–2 weeks for approval.

## Social / community (immediate, ~10 min total)

### Show HN
- **URL:** https://news.ycombinator.com/submit
- **Title:** `Show HN: sec-edgar-mcp — SEC filings + XBRL as an MCP for Claude / Cursor`
- **URL:** `https://github.com/guptaprakhariitr/sec-edgar-mcp`
- **Text (optional):** Brief 2-paragraph: what it does, what's free, what's paid.

### r/ClaudeAI / r/cursor / r/LocalLLaMA
- Post the GitHub URL + a one-line "what" + ask for feedback. Avoid sales pitch.

### Twitter / X
- Thread template (paste, tweak emoji/tone as you like):
  > Just shipped sec-edgar-mcp — a Model Context Protocol server giving Claude / Cursor / Cline real-time access to SEC EDGAR.
  >
  > Search filings, read 10-K/8-K, query XBRL facts, track Form 4 insider trades. Free underlying data.
  >
  > Endpoint: https://sec-edgar-mcp.atlasword.workers.dev/mcp
  > GitHub: https://github.com/guptaprakhariitr/sec-edgar-mcp
  >
  > $9/mo for 2k calls, $29/mo team, $79/mo pro. Free tier 100 calls/mo no signup.

### Anthropic Discord / Cursor Discord / Cline Discord
- Post in the `#showcase` / `#mcp-servers` channels with the same link + one line.

## Tracking

After submitting, log the date + install count for each registry in this file (append below) so we know which channel actually drove signups:

| Date | Registry | Status | Installs (T+7 days) |
|---|---|---|---|
| 2026-06-10 | Glama (auto-crawl) | indexing | TBD |
|  | PulseMCP | TBD | TBD |
|  | mcp.so | TBD | TBD |
|  | mcp.directory | TBD | TBD |
|  | Official MCP Registry | TBD | TBD |
|  | Smithery (paid, skip till MRR > 0) | TBD | TBD |
|  | Cursor Marketplace | TBD | TBD |
