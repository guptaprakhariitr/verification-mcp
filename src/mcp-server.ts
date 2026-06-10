// Vendored from products/_template/src/mcp-server.ts. Keep these two files in sync.

export interface Tool {
  name: string;
  description: string;
  inputSchema: object;
  handler: (args: any, ctx: ToolContext) => Promise<unknown>;
  /** If true, this tool is only available on Team tier or higher. */
  premium?: boolean;
}

export interface ToolContext {
  env: Record<string, any>;
  apiKey: string | null;
  tier: "free" | "solo" | "team" | "pro";
  callsRemaining: number;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: any;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

const PROTOCOL_VERSION = "2025-06-18";

export class McpServer {
  private tools = new Map<string, Tool>();
  constructor(private serverInfo: { name: string; version: string }) {}

  register(tool: Tool): void { this.tools.set(tool.name, tool); }

  listTools(tier: ToolContext["tier"]): Tool[] {
    return Array.from(this.tools.values()).filter((t) => !t.premium || tier === "team" || tier === "pro");
  }

  async handle(req: JsonRpcRequest, ctx: ToolContext): Promise<JsonRpcResponse | null> {
    const id = req.id ?? null;
    try {
      switch (req.method) {
        case "initialize":
          return { jsonrpc: "2.0", id, result: { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: this.serverInfo } };
        case "notifications/initialized":
          return null;
        case "tools/list":
          return {
            jsonrpc: "2.0", id,
            result: {
              tools: this.listTools(ctx.tier).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
            },
          };
        case "tools/call": {
          const { name, arguments: args } = req.params ?? {};
          const tool = this.tools.get(name);
          if (!tool) return rpcError(id, -32601, `Tool not found: ${name}`);
          if (tool.premium && ctx.tier !== "team" && ctx.tier !== "pro") {
            return rpcError(id, -32000, `Tool '${name}' is premium-only. Upgrade to Team or Pro tier to use it.`);
          }
          const result = await tool.handler(args ?? {}, ctx);
          return {
            jsonrpc: "2.0", id,
            result: {
              content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }],
              isError: false,
            },
          };
        }
        case "ping":
          return { jsonrpc: "2.0", id, result: {} };
        default:
          return rpcError(id, -32601, `Method not found: ${req.method}`);
      }
    } catch (err) {
      return rpcError(id, -32603, err instanceof Error ? err.message : String(err));
    }
  }
}

function rpcError(id: number | string | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export function isJsonRpcRequest(body: unknown): body is JsonRpcRequest {
  return typeof body === "object" && body !== null && (body as any).jsonrpc === "2.0" && typeof (body as any).method === "string";
}
