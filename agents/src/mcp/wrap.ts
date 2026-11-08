// Custom wrappers that turn a FirstLine agent tool (agents/loop.ts `Tool`) into an MCP tool.
// The same definitions the Nemotron agents call in-process are served over MCP, so an outside
// client (Claude, NVIDIA NeMo Agent Toolkit, an IDE) sees exactly the tools and schemas the agents
// use. Each wrapper adds what a network boundary needs and an in-process call does not:
//   - input validation with the tool's own zod schema (bad args come back as a readable error)
//   - a timeout, so a slow feed or database can't hang the client
//   - privacy: phone numbers are masked before anything leaves the process
//   - size limits on results
//   - an audit entry for every call (who called what, how long it took, whether it failed)

import { z } from "zod";
import type { Tool } from "../agents/loop.js";

export interface AuditEntry {
  at: string;
  tool: string;
  args: unknown;
  ms: number;
  ok: boolean;
  error?: string;
}

export interface WrapOptions {
  /** Called once per call. Default: one JSON line on stderr (stdout carries the MCP protocol). */
  audit?: (e: AuditEntry) => void;
  timeoutMs?: number;
  /** Longest result text returned to the client. */
  maxChars?: number;
}

export interface McpToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export interface WrappedTool {
  name: string;
  description: string;
  inputSchema: { type: "object"; [k: string]: unknown };
  call(args: unknown): Promise<McpToolResult>;
}

const PHONE = /\+?\d[\d\s().-]{7,}\d/g;

/** Masks phone numbers in any value, and drops fields named like a phone number. */
export function redact(v: unknown): unknown {
  if (typeof v === "string") return v.replace(PHONE, (m) => `***${m.replace(/\D/g, "").slice(-2)}`);
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === "object") {
    if (v instanceof Date) return v.toISOString();
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = /phone/i.test(k) && typeof x === "string" ? (x ? "on file" : "none") : redact(x);
    return out;
  }
  return typeof v === "bigint" ? v.toString() : v;
}

const stderrAudit = (e: AuditEntry) => process.stderr.write(`[mcp] ${JSON.stringify(e)}\n`);

function withTimeout<T>(p: Promise<T>, ms: number, name: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${name} timed out after ${ms} ms`)), ms);
    }),
  ]);
}

export function wrapTool(tool: Tool, opts: WrapOptions = {}): WrappedTool {
  const audit = opts.audit ?? stderrAudit;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const maxChars = opts.maxChars ?? 20_000;
  const schema = z.toJSONSchema(tool.input) as Record<string, unknown>;
  delete schema.$schema;
  const inputSchema = { ...schema, type: "object" as const };

  return {
    name: tool.name,
    description: tool.description,
    inputSchema,
    async call(args) {
      const started = Date.now();
      const done = (ok: boolean, text: string, error?: string): McpToolResult => {
        audit({ at: new Date(started).toISOString(), tool: tool.name, args: redact(args), ms: Date.now() - started, ok, error });
        return { content: [{ type: "text", text: text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text }], ...(ok ? {} : { isError: true }) };
      };
      const parsed = tool.input.safeParse(args ?? {});
      if (!parsed.success) {
        const msg = `bad arguments for ${tool.name}: ${z.prettifyError(parsed.error)}`;
        return done(false, msg, msg);
      }
      try {
        const out = await withTimeout(tool.run(parsed.data), timeoutMs, tool.name);
        return done(true, JSON.stringify(redact(out), null, 2));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return done(false, `${tool.name} failed: ${msg}`, msg);
      }
    },
  };
}
