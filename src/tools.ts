import { Tool } from "./mcp-server";
import { VerifierClient, VerifierEnv } from "./verifier";

export function buildTools(): Tool[] {
  return [
    {
      name: "fact_check",
      description:
        "Verify a factual claim against authoritative sources (Wikipedia, Wikidata, Crossref academic citations). Returns a verdict ('supported' / 'contradicted' / 'mixed' / 'unverified'), a 0–1 confidence score, and the list of sources with excerpts. Use this when an agent is about to assert a fact it isn't 100% sure of, or when post-processing LLM output to flag possibly-hallucinated claims.",
      inputSchema: {
        type: "object",
        properties: {
          claim: { type: "string", description: "A single factual claim, ideally one sentence. Longer text is truncated to 200 chars." },
        },
        required: ["claim"],
      },
      handler: async (args, ctx) => {
        const c = new VerifierClient(ctx.env as unknown as VerifierEnv);
        return await c.factCheck(args.claim);
      },
    },

    {
      name: "cite_check",
      description:
        "Verify that one or more cited URLs (a) resolve, (b) match the cited claim text, and (c) aren't retracted. Useful when an LLM produced inline citations and you want to confirm they're real and on-point. Pass DOIs directly (e.g. '10.1038/nature12373') or full URLs. Up to 25 per call.",
      inputSchema: {
        type: "object",
        properties: {
          citations: {
            type: "array",
            maxItems: 25,
            items: {
              type: "object",
              properties: {
                url: { type: "string", description: "URL or DOI of the cited source." },
                claim: { type: "string", description: "Optional: the claim that this citation is meant to support. If provided, returns a match_score." },
              },
              required: ["url"],
            },
          },
        },
        required: ["citations"],
      },
      handler: async (args, ctx) => {
        const c = new VerifierClient(ctx.env as unknown as VerifierEnv);
        const out = await c.citeCheckBatch(args.citations);
        return { count: out.length, results: out };
      },
    },

    {
      name: "source_freshness",
      description:
        "Check whether a source URL is still live and how recently it was modified. Returns the HTTP last-modified header (if present), the most recent Wayback Machine snapshot, and a 'changed_recently' flag (last 90 days). Use this for RAG hygiene — flagging citations that point to pages that may have changed since the agent's training data.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to check." },
        },
        required: ["url"],
      },
      handler: async (args, ctx) => {
        const c = new VerifierClient(ctx.env as unknown as VerifierEnv);
        return await c.sourceFreshness(args.url);
      },
    },
  ];
}
