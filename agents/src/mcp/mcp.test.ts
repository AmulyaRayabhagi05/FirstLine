import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineTool } from "../agents/loop.js";
import { stubServices } from "../agents/services.js";
import { runTriage } from "../agents/triage.js";
import { FakeLlm } from "../llm/fake.js";
import { InMemoryStore } from "../store/memory.js";
import { createFirstLineMcpServer } from "./server.js";
import { redact, wrapTool, type AuditEntry } from "./wrap.js";

async function connect() {
  const store = new InMemoryStore();
  const services = stubServices();
  const rosa = await store.registerPerson({
    name: "Rosa", age: 81, livesAlone: true, mobility: "cannot_walk", medicalNeeds: "oxygen", poweredDevice: true,
    hasSmartphone: false, language: "es", phone: "+15551234567", address: "Rosa's house", lat: 32.75, lng: -96.83,
  });
  const sosId = await store.pressSos({ clientId: "r1", personId: rosa.personId, message: "agua entrando, no puedo caminar", lat: 32.75, lng: -96.83, channel: "sms" });
  const llm = new FakeLlm({
    triage: [
      { thought: "profile", tool: "get_person_profile", args: {} },
      { thought: "guidance", tool: "lookup_protocol", args: { query: "water rising cannot walk" } },
      { thought: "save", tool: "save_triage", args: { urgency: 5, needs: "professional", priority: "P1", reason: "Water entering, cannot walk [flood-trapped-high]", confidence: 0.95 } },
      { thought: "done", done: true, decision: "P1" },
    ],
  });
  await runTriage({ store, llm, services }, (await store.getSos(sosId))!);
  const audit: AuditEntry[] = [];
  const { server } = createFirstLineMcpServer({ store, services, llm }, { audit: (e) => audit.push(e) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(b);
  const text = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { text: r.content[0]!.text, isError: !!r.isError };
  };
  return { client, text, audit, personId: rosa.personId };
}

describe("FirstLine MCP server", () => {
  it("lists the read-only tools with JSON schemas", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["lookup_protocol", "get_person_profile", "explain_priority", "get_case_trace", "check_message", "list_open_sos"]),
    );
    expect(tools.some((t) => /^(save_|request_|offer)/.test(t.name))).toBe(false);
    expect(tools.find((t) => t.name === "get_person_profile")!.inputSchema).toMatchObject({ type: "object", required: ["person_id"] });
  });

  it("traces a case as hops between lanes", async () => {
    const { text, personId } = await connect();
    const r = await text("get_case_trace", { person_id: personId });
    const events = JSON.parse(r.text).events as { from: string; to: string; kind: string; label: string }[];
    expect(events[0]).toMatchObject({ from: "resident", to: "triage", kind: "sos" });
    expect(events).toContainEqual(expect.objectContaining({ from: "triage", to: "tools", kind: "tool_call" }));
    expect(events).toContainEqual(expect.objectContaining({ from: "tools", to: "triage", kind: "tool_result" }));
    expect(events).toContainEqual(expect.objectContaining({ from: "triage", to: "database", kind: "tool_call" }));
    expect(events.some((e) => e.kind === "decision" && e.label.startsWith("Confidence"))).toBe(true);
  });

  it("never returns phone numbers, and audits every call", async () => {
    const { text, audit, personId } = await connect();
    const r = await text("list_open_sos", {});
    expect(r.text).not.toMatch(/5551234567/);
    await text("explain_priority", { person_id: personId });
    expect(audit.map((e) => e.tool)).toEqual(["list_open_sos", "explain_priority"]);
    expect(audit.every((e) => e.ok)).toBe(true);
  });

  it("returns readable errors for bad arguments and unknown people", async () => {
    const { text, audit } = await connect();
    expect(await text("get_person_profile", {})).toMatchObject({ isError: true, text: expect.stringMatching(/bad arguments/) });
    expect(await text("get_person_profile", { person_id: 999 })).toMatchObject({ isError: true, text: expect.stringMatching(/no person 999/) });
    expect(audit.filter((e) => !e.ok)).toHaveLength(2);
  });
});

describe("wrapTool", () => {
  it("times out slow tools", async () => {
    const slow = defineTool({ name: "slow", description: "", input: z.object({}), run: () => new Promise((r) => setTimeout(r, 200)) });
    const r = await wrapTool(slow, { timeoutMs: 20, audit: () => {} }).call({});
    expect(r).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/timed out/) }] });
  });

  it("masks phone numbers anywhere in a result", () => {
    expect(redact({ phone: "+1 (555) 123-4567", note: "call 555-123-4567 now", n: 5 })).toEqual({ phone: "on file", note: "call ***67 now", n: 5 });
  });
});
