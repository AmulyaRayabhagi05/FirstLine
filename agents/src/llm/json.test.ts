import { describe, expect, it } from "vitest";
import { z } from "zod";
import { BadJsonError, extractJson, jsonCall } from "./json.js";
import { FakeLlm } from "./fake.js";

describe("extractJson", () => {
  it("handles think blocks, fences and prose", () => {
    expect(extractJson('<think>hmm {no}</think>\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Sure! {"a":"}{","b":[1,{"c":2}]} done')).toEqual({ a: "}{", b: [1, { c: 2 }] });
    expect(extractJson('reasoning without open tag</think>{"ok":true}')).toEqual({ ok: true });
  });
});

describe("jsonCall", () => {
  const schema = z.object({ urgency: z.number().int().min(1).max(5) });

  it("retries once with the validation error", async () => {
    const llm = new FakeLlm({ t: ["not json", { urgency: 4 }] });
    const r = await jsonCall({ llm, schema, messages: [{ role: "user", content: "x" }], opts: { tag: "t" } });
    expect(r.value.urgency).toBe(4);
    expect(llm.calls[1]!.messages.at(-1)!.content).toMatch(/not valid/);
  });

  it("gives up after two bad replies", async () => {
    const llm = new FakeLlm({ t: [{ urgency: 9 }, { urgency: 0 }] });
    await expect(
      jsonCall({ llm, schema, messages: [{ role: "user", content: "x" }], opts: { tag: "t" } }),
    ).rejects.toBeInstanceOf(BadJsonError);
  });
});
