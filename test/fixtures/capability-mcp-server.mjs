import { McpServer } from "../../tools/openclaw-runtime/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js";
import { StdioServerTransport } from "../../tools/openclaw-runtime/node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js";

const server = new McpServer({ name: "shadow-isolated-fixture", version: "1.0.0" });
server.registerTool("read", { description: "Read an isolated constant, no filesystem or network access", inputSchema: {}, annotations: { readOnlyHint: true } },
  async () => ({ content: [{ type: "text", text: "isolated fixture result" }] }));
await server.connect(new StdioServerTransport());
