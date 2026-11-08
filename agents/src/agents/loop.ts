// A tiny plan → act → observe → decide loop. Nemotron is served by vLLM without tool-call
// flags, so tool use is JSON-structured output that we parse and validate ourselves.
// Every step is written through store.logAgentStep so the map's reasoning panel shows it.

import { z } from "zod";
import type { ChatMessage, LlmClient } from "../llm/client.js";
import { BadJsonError, jsonCall } from "../llm/json.js";
import type { AgentName, AgentStepKind, FirstLineStore } from "../store/types.js";
import type { Services } from "./services.js";

export interface Tool<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  input: S;
  run(args: z.infer<S>): Promise<unknown>;
}

export function defineTool<S extends z.ZodType>(tool: Tool<S>): Tool<S> {
  return tool;
}

export interface AgentDeps {
  store: FirstLineStore;
  llm: LlmClient;
  services: Services;
  now?: () => Date;
}

/** 0..1, also accepting 0..100 percentages that small models like to emit. */
export const confidence = z.preprocess(
  (v) => (typeof v === "string" ? Number(v) : typeof v === "number" && v > 1 && v <= 100 ? v / 100 : v),
  z.number().min(0).max(1),
);

const asText = (v: unknown) => (v == null ? v : typeof v === "string" ? v : JSON.stringify(v));

/** Normalize the many shapes a small model uses for one step before validating. */
function normalizeStep(v: unknown): unknown {
  if (!v || typeof v !== "object" || Array.isArray(v)) return v;
  const o = v as Record<string, unknown>;
  const pick = (...keys: string[]) => keys.map((k) => o[k]).find((x) => x !== undefined);
  let tool = pick("tool", "tool_name", "action", "function", "name");
  if (tool && typeof tool === "object") tool = (tool as Record<string, unknown>).name;
  if (typeof tool === "string") {
    tool = tool.trim().replace(/\(\)$/, "").toLowerCase();
    if (["", "null", "none", "n/a"].includes(tool as string)) tool = null;
  }
  let args = pick("args", "arguments", "parameters", "input", "tool_args");
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      args = {};
    }
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) args = {};
  let done = pick("done", "finished", "final");
  if (typeof done === "string") done = done.trim().toLowerCase() === "true";
  return {
    thought: asText(pick("thought", "thoughts", "reasoning", "plan")) ?? "",
    tool: typeof tool === "string" ? tool : null,
    args,
    done: typeof done === "boolean" ? done : null,
    decisionValue: pick("decision", "final_answer", "answer", "result"),
    confidence: pick("confidence"),
  };
}

const stepSchema = z.preprocess(
  normalizeStep,
  z.object({
    thought: z.string(),
    tool: z.string().nullish(),
    args: z.record(z.string(), z.unknown()),
    done: z.boolean().nullish(),
    decisionValue: z.unknown(),
    confidence: confidence.nullish().catch(undefined),
  }),
);

export interface ToolCallRecord {
  tool: string;
  args: unknown;
  result?: unknown;
  error?: string;
}

export interface LoopResult {
  finished: boolean;
  decision?: string;
  /** The model's final answer as it sent it (may be an object), for agents to salvage. */
  decisionValue?: unknown;
  confidence?: number;
  calls: ToolCallRecord[];
  model?: string;
  /** Set when the model was unreachable or unusable; callers then apply rule fallbacks. */
  error?: string;
}

export interface LoopArgs {
  agent: AgentName;
  subject: string;
  deps: AgentDeps;
  /** Role and rules for this agent. Tool list and reply format are appended. */
  instructions: string;
  task: string;
  tools: Tool[];
  maxSteps?: number;
  tier?: "fast" | "plan";
  /** Tools that must succeed before done=true is accepted; the model is reminded otherwise. */
  requiredTools?: string[];
}

export const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function stepLogger(store: FirstLineStore, agent: AgentName, subject: string) {
  return async (kind: AgentStepKind, content: string, conf?: number) => {
    try {
      await store.logAgentStep({ agent, subject, kind, content: truncate(content, 500), confidence: conf });
    } catch (err) {
      console.error(`[${agent}] logAgentStep failed:`, err);
    }
  };
}

function describeTools(tools: Tool[]): string {
  return tools
    .map((t) => {
      const schema = z.toJSONSchema(t.input) as Record<string, unknown>;
      delete schema.$schema;
      return `- ${t.name}: ${t.description}\n  args: ${JSON.stringify(schema)}`;
    })
    .join("\n");
}

export function systemPrompt(instructions: string, tools: Tool[]): string {
  return [
    "/no_think",
    instructions.trim(),
    "",
    "Tools you can call:",
    describeTools(tools),
    "",
    "Reply with ONLY one JSON object, no prose, in this shape:",
    '{"thought": "<one short sentence>", "tool": "<tool name or null>", "args": {<tool args>}, "done": <true|false>, "decision": "<final decision, when done>", "confidence": <0..1>}',
    "Call one tool per reply. You will get the tool's result, then reply again. Results are saved ONLY by calling the save tool; \"decision\" is just a short sentence. Set done=true only when your work is finished.",
  ].join("\n");
}

export async function runAgentLoop(a: LoopArgs): Promise<LoopResult> {
  const log = stepLogger(a.deps.store, a.agent, a.subject);
  const toolsByName = new Map(a.tools.map((t) => [t.name, t]));
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt(a.instructions, a.tools) },
    { role: "user", content: a.task },
  ];
  const calls: ToolCallRecord[] = [];
  const maxSteps = a.maxSteps ?? 6;
  let model: string | undefined;
  let nudges = 0;

  for (let step = 0; step < maxSteps; step++) {
    let reply: z.infer<typeof stepSchema>;
    try {
      const res = await jsonCall({ llm: a.deps.llm, schema: stepSchema, messages, opts: { tag: a.agent, tier: a.tier } });
      reply = res.value;
      model = res.model;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const raw = err instanceof BadJsonError ? ` Raw reply: ${truncate(err.raw.replace(/\s+/g, " "), 200)}` : "";
      await log("thought", `Model unavailable or unusable (${truncate(msg, 160)}); falling back to rules.${raw}`);
      return { finished: false, calls, model, error: msg };
    }
    messages.push({ role: "assistant", content: JSON.stringify(reply) });
    if (reply.thought) await log("thought", reply.thought, reply.confidence ?? undefined);

    let observation: string | undefined;
    if (reply.tool) {
      const tool = toolsByName.get(reply.tool);
      const args = reply.args ?? {};
      await log("tool_call", `${reply.tool}(${JSON.stringify(args)})`);
      const rec: ToolCallRecord = { tool: reply.tool, args };
      calls.push(rec);
      if (!tool) {
        rec.error = `unknown tool "${reply.tool}"`;
      } else {
        const parsed = tool.input.safeParse(args);
        if (!parsed.success) {
          rec.error = `bad args: ${z.prettifyError(parsed.error)}`;
        } else {
          rec.args = parsed.data;
          try {
            rec.result = await tool.run(parsed.data);
          } catch (err) {
            rec.error = err instanceof Error ? err.message : String(err);
          }
        }
      }
      const resultText = rec.error ? `ERROR: ${rec.error}` : JSON.stringify(rec.result ?? null);
      await log("tool_result", `${reply.tool} → ${resultText}`);
      observation = `Result of ${reply.tool}: ${truncate(resultText, 2500)}`;
    }

    const missing = (a.requiredTools ?? []).filter((t) => !called({ finished: false, calls }, t));
    if (reply.done && missing.length > 0 && nudges < 2) {
      nudges++;
      await log("thought", `Not finished: ${missing.join(", ")} has not been called yet.`);
      messages.push({
        role: "user",
        content: `${observation ? `${observation}\n` : ""}You set done=true but did not call ${missing.join(", ")}. Call ${missing[0]} now with your decision as its args.`,
      });
      continue;
    }
    if (reply.done) {
      const decision = asText(reply.decisionValue) || reply.thought || "done";
      await log("decision", decision, reply.confidence ?? undefined);
      return { finished: true, decision, decisionValue: reply.decisionValue, confidence: reply.confidence ?? undefined, calls, model };
    }
    messages.push({
      role: "user",
      content: observation ?? "You did not call a tool. Call one of the tools, or set done=true with your decision.",
    });
  }
  await log("thought", `Reached the ${maxSteps}-step limit without finishing.`);
  return { finished: false, calls, model, error: "max steps" };
}

export const called = (r: LoopResult, tool: string) => r.calls.some((c) => c.tool === tool && !c.error);
