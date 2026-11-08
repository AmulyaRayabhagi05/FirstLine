// Thin Twilio layer: an injectable client interface (so tests and demos never hit the network),
// signature validation, and the outbound sendSms tool for the agents.

import twilio from "twilio";
import { z } from "zod";
import { toE164 } from "./store.js";

/** The two Twilio REST calls messaging makes. The real `twilio()` client satisfies this. */
export interface TwilioLike {
  messages: { create(opts: { to: string; from: string; body: string }): Promise<{ sid: string }> };
  calls: {
    create(opts: {
      to: string;
      from: string;
      twiml?: string;
      url?: string;
      statusCallback?: string;
      statusCallbackEvent?: string[];
      timeout?: number;
    }): Promise<{ sid: string }>;
  };
}

export interface TwilioConfig {
  accountSid?: string;
  authToken?: string;
  fromNumber?: string;
  /** Public base URL Twilio can reach (ngrok etc.), no trailing slash. */
  publicUrl?: string;
  /**
   * Accept webhooks without a valid X-Twilio-Signature when no auth token is set. Local dev only
   * (TWILIO_ALLOW_UNSIGNED=1): without a signature anyone who finds the URL can mark people safe
   * (`FL OK`, `/voice/result?personId=N` with Digits=1) or file SOS events.
   */
  allowUnsigned?: boolean;
}

export function twilioConfigFromEnv(env: NodeJS.ProcessEnv = process.env): TwilioConfig {
  return {
    accountSid: env.TWILIO_ACCOUNT_SID,
    authToken: env.TWILIO_AUTH_TOKEN,
    fromNumber: env.TWILIO_FROM_NUMBER,
    publicUrl: env.PUBLIC_BASE_URL?.replace(/\/$/, ""),
    allowUnsigned: env.TWILIO_ALLOW_UNSIGNED === "1",
  };
}

/** Real client when credentials exist, otherwise a mock that logs and records what it would send. */
export function createTwilioClient(cfg: TwilioConfig): TwilioLike {
  if (cfg.accountSid && cfg.authToken) {
    return twilio(cfg.accountSid, cfg.authToken) as unknown as TwilioLike;
  }
  return new MockTwilio();
}

export class MockTwilio implements TwilioLike {
  readonly sent: { to: string; from: string; body: string }[] = [];
  readonly placed: Parameters<TwilioLike["calls"]["create"]>[0][] = [];
  private n = 0;
  messages = {
    create: async (opts: { to: string; from: string; body: string }) => {
      this.sent.push(opts);
      return { sid: `SMmock${++this.n}` };
    },
  };
  calls = {
    create: async (opts: Parameters<TwilioLike["calls"]["create"]>[0]) => {
      this.placed.push(opts);
      return { sid: `CAmock${++this.n}` };
    },
  };
}

/**
 * Validates X-Twilio-Signature. Fails closed: with no auth token configured every request is
 * refused unless `allowUnsigned` is set (TWILIO_ALLOW_UNSIGNED=1, local dev only).
 */
export function isValidTwilioRequest(
  authToken: string | undefined,
  signature: string | undefined,
  url: string,
  params: Record<string, string>,
  allowUnsigned = false,
): boolean {
  if (!authToken) return allowUnsigned;
  if (!signature) return false;
  return twilio.validateRequest(authToken, signature, url, params);
}

/** Tool shape shared with the agent worker. */
export interface MessagingTool<I extends z.ZodTypeAny, O> {
  name: string;
  description: string;
  inputSchema: I;
  run(input: z.infer<I>): Promise<O>;
}

const sendSmsInput = z.object({
  to: z.string().min(7).describe("Destination phone number in E.164, e.g. +12145550123"),
  body: z.string().min(1).max(1600).describe("Message text. Keep it short and plain."),
});

export function makeSendSmsTool(
  client: TwilioLike,
  cfg: TwilioConfig,
): MessagingTool<typeof sendSmsInput, { sid: string }> {
  return {
    name: "send_sms",
    description: "Send a text message to a person or helper by phone number.",
    inputSchema: sendSmsInput,
    run: async (input) => sendSms(client, cfg, input.to, input.body),
  };
}

export async function sendSms(client: TwilioLike, cfg: TwilioConfig, to: string, body: string) {
  if (!cfg.fromNumber) throw new Error("TWILIO_FROM_NUMBER is not set");
  const msg = await client.messages.create({ to: toE164(to), from: cfg.fromNumber, body });
  return { sid: msg.sid };
}

export function xmlEscape(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);
}

export function smsTwiml(reply: string): string {
  const r = new twilio.twiml.MessagingResponse();
  r.message(reply);
  return r.toString();
}

/** A TwiML response that sends nothing back. */
export function emptyTwiml(): string {
  return new twilio.twiml.MessagingResponse().toString();
}
