// HTTP server for Twilio webhooks (plain node:http).
//   POST /sms            inbound SMS
//   POST /voice/result   Gather action of a check-in call
//   POST /voice/status   call status callback
//   POST /voice/inbound  someone calls the FirstLine number (conversation with Nemotron)
//   POST /voice/converse each spoken turn of that conversation
//   GET  /health

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { handleInboundText } from "./inbound.js";
import { handleConverse, handleInboundCall, speakAndHangup, type VoiceAssistant } from "./inbound-voice.js";
import { inboundLimiter, type RateLimiter } from "./ratelimit.js";
import type { ChannelStore } from "./store.js";
import { emptyTwiml, isValidTwilioRequest, smsTwiml, type TwilioConfig } from "./twilio.js";
import { handleVoiceResult, handleVoiceStatus, type VoiceDeps } from "./voice.js";

export interface ServerDeps extends VoiceDeps {
  store: ChannelStore;
  cfg: TwilioConfig;
  /** Per-phone-number limit on inbound SMS (default 10 per 10 minutes). */
  limiter?: RateLimiter;
  /** Answers inbound calls; without it the line says to call 911 and hangs up. */
  assistant?: VoiceAssistant;
}

const MAX_BODY = 64 * 1024;

class BodyTooLarge extends Error {}

async function readForm(req: IncomingMessage): Promise<Record<string, string>> {
  if (Number(req.headers["content-length"] ?? 0) > MAX_BODY) throw new BodyTooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new BodyTooLarge();
    chunks.push(c as Buffer);
  }
  return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString("utf8")));
}

/** The URL Twilio signed: PUBLIC_BASE_URL + path when set (proxies/ngrok rewrite Host). */
function signedUrl(req: IncomingMessage, cfg: TwilioConfig): string {
  if (cfg.publicUrl) return `${cfg.publicUrl}${req.url}`;
  const proto = (req.headers["x-forwarded-proto"] as string) ?? "http";
  return `${proto}://${req.headers.host}${req.url}`;
}

function send(res: ServerResponse, status: number, body: string, type = "text/xml") {
  res.writeHead(status, { "content-type": type });
  res.end(body);
}

export function createMessagingHandler(deps: ServerDeps) {
  const limiter = deps.limiter ?? inboundLimiter();
  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? "/", "http://local");
      if (req.method === "GET" && url.pathname === "/health") return send(res, 200, "ok", "text/plain");
      if (req.method !== "POST") return send(res, 404, "not found", "text/plain");

      const form = await readForm(req);
      const sig = req.headers["x-twilio-signature"] as string | undefined;
      if (!isValidTwilioRequest(deps.cfg.authToken, sig, signedUrl(req, deps.cfg), form, deps.cfg.allowUnsigned)) {
        return send(res, 403, "invalid signature", "text/plain");
      }

      if (url.pathname === "/sms") {
        const from = form.From ?? "";
        const sid = form.MessageSid ?? form.SmsSid;
        if (!sid) return send(res, 400, "missing MessageSid", "text/plain");
        if (!limiter.allow(`sms:${from}`)) {
          // Empty TwiML: no reply, so a flood does not also cost outbound SMS.
          return send(res, 200, emptyTwiml());
        }
        const person = await deps.store.findPersonByPhone(from);
        const { outcome } = await handleInboundText(deps.store, {
          clientId: `sms:${sid}`,
          text: form.Body ?? "",
          channel: "sms",
          person,
        });
        return send(res, 200, smsTwiml(outcome.reply));
      }

      if (url.pathname === "/voice/inbound" || url.pathname === "/voice/converse") {
        const from = form.From ?? "";
        const callSid = form.CallSid ?? "";
        if (url.pathname === "/voice/inbound") {
          if (!limiter.allow(`call:${from}`)) return send(res, 200, speakAndHangup("Please try again in a few minutes. If this is an emergency, call 9 1 1.", "en"));
          return send(res, 200, await handleInboundCall(deps.assistant, deps.cfg, { callSid, from }));
        }
        const lang = url.searchParams.get("lang") === "es" ? "es" : "en";
        const twiml = await handleConverse(deps.assistant, deps.cfg, {
          callSid,
          from,
          speech: form.SpeechResult,
          digits: form.Digits,
          turn: Number(url.searchParams.get("turn") ?? 1),
          empty: Number(url.searchParams.get("empty") ?? 0),
          lang,
        });
        return send(res, 200, twiml);
      }

      const personId = Number(url.searchParams.get("personId"));
      if (!Number.isInteger(personId) || personId <= 0) return send(res, 400, "bad personId", "text/plain");
      const callSid = form.CallSid ?? "";

      if (url.pathname === "/voice/result") {
        const { twiml } = await handleVoiceResult(deps, {
          personId,
          callSid,
          lang: url.searchParams.get("lang") ?? undefined,
          attempt: Number(url.searchParams.get("attempt") ?? 0),
          noInput: url.searchParams.get("noinput") === "1",
          digits: form.Digits,
          speechResult: form.SpeechResult,
        });
        return send(res, 200, twiml);
      }

      if (url.pathname === "/voice/status") {
        await handleVoiceStatus(deps, { personId, callSid, callStatus: form.CallStatus ?? "" });
        return send(res, 204, "", "text/plain");
      }

      return send(res, 404, "not found", "text/plain");
    } catch (err) {
      if (err instanceof BodyTooLarge) return send(res, 413, "body too large", "text/plain");
      console.error("[messaging] webhook error", err instanceof Error ? err.message : err);
      return send(res, 500, "error", "text/plain");
    }
  };
}

export function createMessagingServer(deps: ServerDeps): Server {
  const server = createServer(createMessagingHandler(deps));
  // Twilio answers in well under a second; do not let slow clients hold sockets open.
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  return server;
}
