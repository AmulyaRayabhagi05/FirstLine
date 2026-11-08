import { z } from "zod";
import type { ChatMessage, ChatOptions, LlmClient } from "./client.js";

/** Pull the first JSON object out of a model reply (handles <think>, code fences, prose). */
export function extractJson(text: string): unknown {
  let t = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  // An unterminated <think> means everything before </think> is reasoning.
  const closeIdx = t.lastIndexOf("</think>");
  if (closeIdx >= 0) t = t.slice(closeIdx + "</think>".length);
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1]!;
  const start = t.indexOf("{");
  if (start < 0) throw new Error("no JSON object in reply");
  // Walk to the matching closing brace, respecting strings.
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return JSON.parse(t.slice(start, i + 1));
    }
  }
  throw new Error("unterminated JSON object in reply");
}

export interface JsonCallArgs<S extends z.ZodType> {
  llm: LlmClient;
  schema: S;
  messages: ChatMessage[];
  opts?: ChatOptions;
}

export interface JsonCallResult<T> {
  value: T;
  model: string;
  raw: string;
}

export class BadJsonError extends Error {
  constructor(
    message: string,
    readonly raw: string,
  ) {
    super(message);
  }
}

/**
 * Ask the model for JSON matching `schema`. On unparseable or invalid output, retries once
 * with the validation error appended so the model can fix it.
 */
export async function jsonCall<S extends z.ZodType>(args: JsonCallArgs<S>): Promise<JsonCallResult<z.infer<S>>> {
  const messages = [...args.messages];
  let lastErr = "";
  let lastRaw = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await args.llm.chat(messages, args.opts);
    lastRaw = res.content;
    try {
      const parsed = args.schema.safeParse(extractJson(res.content));
      if (parsed.success) return { value: parsed.data, model: res.model, raw: res.content };
      lastErr = z.prettifyError(parsed.error);
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    messages.push(
      { role: "assistant", content: res.content },
      {
        role: "user",
        content: `That reply was not valid: ${lastErr}\nReply again with ONLY one JSON object that fixes this.`,
      },
    );
  }
  throw new BadJsonError(`model returned invalid JSON twice: ${lastErr}`, lastRaw);
}
