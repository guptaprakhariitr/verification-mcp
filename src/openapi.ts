// GET /openapi.json — auto-generated OpenAPI 3.1 schema describing the MCP
// endpoint and every tool this product exposes. Vendored identically across
// every Category-1 product; the per-product tool list is read from the same
// `buildTools()` registry that mcp-server uses, so the schema can never drift
// from reality.

import { Tool } from "./mcp-server";

export interface OpenApiEnv {
  PRODUCT_NAME?: string;
  PRODUCT_TAGLINE?: string;
  PRODUCT_URL?: string;
}

interface OpenApiOpts {
  serverInfo: { name: string; version: string };
  tools: Tool[];
  origin: string;
}

export function handleOpenApi(env: OpenApiEnv, opts: OpenApiOpts): Response {
  const productName = env.PRODUCT_NAME || opts.serverInfo.name;
  const description =
    env.PRODUCT_TAGLINE ||
    `Model Context Protocol (MCP) server exposed over JSON-RPC at POST /mcp. ${opts.tools.length} tools.`;
  const serverUrl = env.PRODUCT_URL || opts.origin;

  // Each tool gets its own tools/call convenience operation so the spec is
  // discoverable by OpenAPI-aware tooling. The actual transport is JSON-RPC,
  // so we ALSO describe POST /mcp generically.
  const toolPaths: Record<string, unknown> = {};
  for (const t of opts.tools) {
    toolPaths[`/mcp#${t.name}`] = {
      post: {
        summary: t.description.split(". ")[0] || t.name,
        description: t.description,
        operationId: `tools_call_${t.name}`,
        tags: ["tools/call"],
        "x-mcp-tool-name": t.name,
        "x-mcp-premium": Boolean(t.premium),
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["jsonrpc", "method", "params"],
                properties: {
                  jsonrpc: { type: "string", const: "2.0" },
                  id: { oneOf: [{ type: "string" }, { type: "integer" }, { type: "null" }] },
                  method: { type: "string", const: "tools/call" },
                  params: {
                    type: "object",
                    required: ["name"],
                    properties: {
                      name: { type: "string", const: t.name },
                      arguments: t.inputSchema as Record<string, unknown>,
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "JSON-RPC result. The `result.content[0].text` is a JSON string of the tool's return value.",
            content: { "application/json": { schema: jsonRpcResultSchema() } },
            headers: rateLimitHeaderSpec(),
          },
          "429": {
            description: "Quota / rate-limit exceeded.",
            content: { "application/json": { schema: { type: "object" } } },
          },
        },
      },
    };
  }

  const spec = {
    openapi: "3.1.0",
    info: {
      title: productName,
      version: opts.serverInfo.version,
      description,
      contact: { name: "Praksha Technologies", email: "prakshatechnologies@gmail.com", url: "https://github.com/guptaprakhariitr" },
      license: { name: "MIT" },
    },
    servers: [{ url: serverUrl }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "Send an `mck_*` API key (paid tier) or omit for anonymous free tier.",
        },
      },
    },
    paths: {
      "/mcp": {
        post: {
          summary: "MCP JSON-RPC endpoint (all methods)",
          description:
            "JSON-RPC 2.0 transport for the Model Context Protocol. Supported methods: `initialize`, `tools/list`, `tools/call`, `ping`. See https://modelcontextprotocol.io for the protocol spec.",
          operationId: "mcp_jsonrpc",
          tags: ["mcp"],
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["jsonrpc", "method"],
                  properties: {
                    jsonrpc: { type: "string", const: "2.0" },
                    id: { oneOf: [{ type: "string" }, { type: "integer" }, { type: "null" }] },
                    method: { type: "string", enum: ["initialize", "tools/list", "tools/call", "ping", "notifications/initialized"] },
                    params: { type: "object" },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "JSON-RPC response.",
              headers: rateLimitHeaderSpec(),
              content: { "application/json": { schema: jsonRpcResultSchema() } },
            },
            "204": { description: "Notification accepted, no body." },
            "400": { description: "Invalid JSON-RPC request." },
            "429": { description: "Quota or rate-limit exceeded." },
          },
        },
      },
      "/account": {
        get: {
          summary: "Account record + usage + Dodo portal link",
          security: [{ bearerAuth: [] }],
          responses: { "200": { description: "Account JSON." } },
        },
      },
      "/upgrade": {
        get: {
          summary: "Redirect to Dodo checkout (or mint free-tier key when tier=free)",
          parameters: [
            { name: "tier", in: "query", required: true, schema: { type: "string", enum: ["free", "solo", "team", "pro"] } },
            { name: "email", in: "query", required: false, schema: { type: "string", format: "email" } },
          ],
          responses: {
            "302": { description: "Redirect to checkout or /welcome." },
          },
        },
      },
      "/openapi.json": {
        get: {
          summary: "This document.",
          responses: { "200": { description: "OpenAPI 3.1 schema." } },
        },
      },
      "/health": {
        get: { summary: "Liveness probe.", responses: { "200": { description: "OK." } } },
      },
    },
    "x-mcp": {
      tools: opts.tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        premium: Boolean(t.premium),
      })),
      // Embed the per-tool path keys so explorers can find them.
      toolPaths: Object.keys(toolPaths),
    },
  };

  // Merge tool-specific operations into paths.
  Object.assign(spec.paths, toolPaths);

  return new Response(JSON.stringify(spec, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=300",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function rateLimitHeaderSpec(): Record<string, unknown> {
  return {
    "X-RateLimit-Limit": { schema: { type: "integer" }, description: "Monthly call limit for the caller's tier." },
    "X-RateLimit-Remaining": { schema: { type: "integer" }, description: "Calls remaining this month." },
    "X-RateLimit-Reset": { schema: { type: "integer" }, description: "Unix-ms timestamp when the monthly counter resets." },
    "X-Tier": { schema: { type: "string", enum: ["free", "solo", "team", "pro"] }, description: "Tier resolved from the Bearer key (or 'free' if anonymous)." },
  };
}

function jsonRpcResultSchema(): Record<string, unknown> {
  return {
    type: "object",
    required: ["jsonrpc"],
    properties: {
      jsonrpc: { type: "string", const: "2.0" },
      id: { oneOf: [{ type: "string" }, { type: "integer" }, { type: "null" }] },
      result: { type: "object" },
      error: {
        type: "object",
        properties: {
          code: { type: "integer" },
          message: { type: "string" },
          data: { type: "object" },
        },
      },
    },
  };
}
