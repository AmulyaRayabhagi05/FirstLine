// A tiny plan → act → observe → decide loop. Nemotron is served by vLLM without tool-call
// flags, so tool use is JSON-structured output that we parse and validate ourselves.
// Every step is written through store.logAgentStep so the map's reasoning panel shows it.

import { z } from "zod";
import type { ChatMessage, LlmClient } from "../llm/client.js";
import { jsonCall } from "../llm/json.js";
import type { AgentName, AgentStepKind, PorchlightStore } from "../store/types.js";
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
  store: PorchlightStore;
  llm: LlmClient;
  services: Services;
  now?: () => Date;
}

/** 0..1, also accepting 0..100 percentages that small models like to emit. */
export const confidence = z.preprocess(
  (v) => (typeof v === "string" ? Number(v) : typeof v === "number" && v > 1 && v <= 100 ? v / 100 : v),
  z.number().min(0).max(1),
);

const stepSchema = z.object({
  thought: z.string().default(""),
  tool: z.string().nullish(),
  args: z.record(z.string(), z.unknown()).nullish(),
  done: z.boolean().nullish(),
  decision: z.string().nullish(),
  confidence: confidence.nullish(),
});

export interface ToolCallRecord {
  tool: string;
  args: unknown;
  result?: unknown;
  error?: string;
}

export interface LoopResult {
  finished: boolean;
  decision?: string;
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
}

export const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function stepLogger(store: PorchlightStore, agent: AgentName, subject: string) {
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
    "Call one tool per reply. You will get the tool's result, then reply again. Set done=true only when your work is finished.",
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

  for (let step = 0; step < maxSteps; step++) {
    let reply: z.infer<typeof stepSchema>;
    try {
      const res = await jsonCall({ llm: a.deps.llm, schema: stepSchema, messages, opts: { tag: a.agent, tier: a.tier } });
      reply = res.value;
      model = res.model;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await log("thought", `Model unavailable or unusable (${truncate(msg, 120)}); falling back to rules.`);
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

    if (reply.done) {
      const decision = reply.decision || reply.thought || "done";
      await log("decision", decision, reply.confidence ?? undefined);
      return { finished: true, decision, confidence: reply.confidence ?? undefined, calls, model };
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
