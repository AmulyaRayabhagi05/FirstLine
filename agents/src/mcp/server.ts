// FirstLine MCP server (stdio). Serves the read-only FirstLine tools (mcp/tools.ts) through the
// custom wrappers in mcp/wrap.ts, so any MCP client can look up the cited guidance, explain a
// risk score, or trace a case the way the agents see it.
//
//   cd agents && npm run mcp                      # in-memory demo data if SPACETIME_DB_NAME is unset
//   claude mcp add firstline -- npm --prefix agents run -s mcp
//
// With SPACETIME_DB_NAME set it reads the live database with the worker's token (SPACETIME_TOKEN),
// which must be staff or the worker identity to see anything. Results never include phone numbers.

import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { AgentDeps } from "../agents/loop.js";
import { loadEnvFile } from "../llm/env.js";
import { channelStoreFor } from "../runtime/channels.js";
import { buildServices } from "../runtime/services.js";
import { InMemoryStore } from "../store/memory.js";
import { SpacetimeStore, spacetimeConfigFromEnv } from "../store/spacetime.js";
import type { FirstLineStore } from "../store/types.js";
import { buildMcpTools } from "./tools.js";
import { wrapTool, type WrapOptions, type WrappedTool } from "./wrap.js";

export function createFirstLineMcpServer(deps: AgentDeps, opts: WrapOptions = {}) {
  const tools = new Map<string, WrappedTool>(buildMcpTools(deps).map((t) => [t.name, wrapTool(t, opts)]));
  const server = new Server({ name: "firstline", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...tools.values()].map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = tools.get(req.params.name);
    if (!tool) return { content: [{ type: "text" as const, text: `unknown tool "${req.params.name}"` }], isError: true };
    return tool.call(req.params.arguments ?? {});
  });
  return { server, tools };
}

export async function main(env: NodeJS.ProcessEnv = process.env) {
  // stdout carries the protocol; send every log line to stderr.
  console.log = (...a: unknown[]) => console.error(...a);
  loadEnvFile();
  let store: FirstLineStore;
  if (env.SPACETIME_DB_NAME) store = await SpacetimeStore.connect(spacetimeConfigFromEnv(env));
  else store = new InMemoryStore();
  const { services } = buildServices(store, channelStoreFor(store), env);
  // The MCP tools never call the model; the llm slot is unused.
  const deps: AgentDeps = { store, services, llm: { chat: async () => { throw new Error("no model in the MCP server"); } } };
  const { server } = createFirstLineMcpServer(deps);
  await server.connect(new StdioServerTransport());
  console.error(`[mcp] FirstLine MCP server ready (${env.SPACETIME_DB_NAME ? `SpacetimeDB ${env.SPACETIME_DB_NAME}` : "in-memory store"})`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error("[mcp] failed to start:", err);
    process.exit(1);
  });
}
