import type { ChatMessage, ChatOptions, ChatResult, LlmClient } from "./client.js";

export type FakeReply = string | object | ((messages: ChatMessage[]) => string | object);

/**
 * Scripted LLM for tests. Replies are queued per `tag` (the agent name). Objects are
 * JSON-stringified; functions see the conversation so far. When a queue is empty the fake
 * throws, which the agents treat like the model being down (rule fallback).
 */
export class FakeLlm implements LlmClient {
  readonly calls: { tag: string | undefined; messages: ChatMessage[] }[] = [];
  private readonly queues = new Map<string, FakeReply[]>();

  constructor(script: Record<string, FakeReply[]> = {}) {
    for (const [tag, replies] of Object.entries(script)) this.queues.set(tag, [...replies]);
  }

  push(tag: string, ...replies: FakeReply[]): this {
    const q = this.queues.get(tag) ?? [];
    q.push(...replies);
    this.queues.set(tag, q);
    return this;
  }

  remaining(tag: string): number {
    return this.queues.get(tag)?.length ?? 0;
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    this.calls.push({ tag: opts.tag, messages: [...messages] });
    const q = this.queues.get(opts.tag ?? "default");
    const next = q?.shift();
    if (next === undefined) throw new Error(`FakeLlm: no scripted reply for tag "${opts.tag ?? "default"}"`);
    const out = typeof next === "function" ? next(messages) : next;
    return { content: typeof out === "string" ? out : JSON.stringify(out), model: "fake-nemotron" };
  }
}
