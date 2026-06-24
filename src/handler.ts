import { HubConnection } from "@microsoft/signalr";
import { config } from "./config";
import { buildInvokeResponse } from "./invokeResponses";

// Handles one inbound SocketActivityEnvelope.
//   { type, envelopeId, cv, payload: <BotActivity>, ackRequired? }
// For invokes (type === "invoke", or payload.type === "invoke") APX is blocked on
// a synchronous reply, so we send an "invokeResponse" frame back over the socket.
// The correlation key is the envelopeId (APX stamps it as {podId}:{guid}).
//
// Behavior is directive-driven via payload.value.directive so a single bot can
// drive every scenario from the INT test that sends the invoke:
//   ok    -> 200 + body            (happy path / dedup target)
//   error -> 500 + error body      (bot handler failure)
//   delay -> sleep payload.value.delayMs (default 27000) then 200  (force 25s timeout -> fallback)
//   drop  -> no reply at all       (force timeout)
//   dupe  -> send the reply twice  (exercise APX first-reply-wins dedup)

// The APX → bot envelope is serialized by the Azure SignalR Management SDK, whose
// default hub protocol may emit PascalCase property names (ignoring APX's Newtonsoft
// [JsonProperty] camelCase). The model fields (Type/EnvelopeId/Cv/Payload/...) are
// therefore read case-insensitively via g(). The invoke *value* contents (directive,
// delayMs) are data passed through verbatim, so they keep whatever casing the caller set.
function g(obj: any, name: string): any {
  if (obj == null) return undefined;
  if (obj[name] !== undefined) return obj[name];
  const cap = name.charAt(0).toUpperCase() + name.slice(1);
  return obj[cap];
}

export async function handleEnvelope(conn: HubConnection, env: any): Promise<void> {
  // Stamp receipt time immediately so botProcessingMs (= bot-sent ts − recvAt) reflects real
  // handling time, not ~0. Both timestamps share the single bot clock, so the metric is skew-free.
  const recvAt = Date.now();
  const type = g(env, "type");
  const payload = g(env, "payload") || {};
  const envelopeId = g(env, "envelopeId");
  const cv = g(env, "cv");
  const isInvoke = type === "invoke" || g(payload, "type") === "invoke";

  console.log(`\n[recv] <-- APX  envelopeId=${envelopeId} type=${type} cv=${cv} isInvoke=${isInvoke} ackRequired=${g(env, "ackRequired")}`);
  console.log(
    `[recv]   activity.name=${g(payload, "name")} activity.type=${g(payload, "type")} ` +
      `value=${truncate(JSON.stringify(g(payload, "value")))}`
  );
  console.log(`[recv]   full activity payload=${truncate(JSON.stringify(payload), 1500)}`);

  if (isInvoke) {
    const value = g(payload, "value") || {};
    const directive = String(value.directive ?? value.Directive ?? config.defaultDirective).toLowerCase();
    console.log(`[recv]   -> invoke, directive=${directive}, name=${g(payload, "name")}`);
    await respondToInvoke(conn, envelopeId, cv, payload, directive, recvAt);
    return;
  }

  // One-way activity = the socket equivalent of the old bot's onMessageActivity handler. APX
  // delivers it with ackRequired=true and awaits a delivery Ack. The directive simulates the
  // handler's outcome so we can exercise both success and error paths:
  //   ok    -> handler succeeds  -> send Ack            (APX: AckResult.Success)
  //   error -> handler throws    -> NO Ack sent         (APX: AckResult.Timeout -> HTTP fallback)
  //   drop  -> delivery dropped  -> NO Ack sent         (APX: AckResult.Timeout)
  //   delay -> handler is slow   -> Ack after a delay   (APX: Success if within deadline)
  if (g(env, "ackRequired")) {
    const aType = g(payload, "type");
    const value = g(payload, "value") || {};
    const directive = String(value.directive ?? value.Directive ?? "ok").toLowerCase();
    console.log(`[msg] onMessageActivity (socket) type=${aType} directive=${directive} envelopeId=${envelopeId}`);

    if (directive === "error" || directive === "drop") {
      const why = directive === "error" ? "handler threw" : "delivery dropped";
      console.log(`[msg] ${directive.toUpperCase()} (${why}) — NOT sending Ack -> expect APX AckResult.Timeout`);
      return;
    }
    if (directive === "delay") {
      const ms = Number(value.delayMs ?? value.DelayMs ?? 27000);
      console.log(`[msg] DELAY ${ms}ms before ack (tests APX ack deadline)`);
      await sleep(ms);
    }

    try {
      console.log(`[ack] --> APX  Ack envelopeId=${envelopeId} (${aType} delivered + handled; sending delivery confirmation)`);
      await conn.send("Ack", { envelopeId, botKey: config.botKey, ts: Date.now(), recvAt });
      console.log(`[ack]   sent ok envelopeId=${envelopeId} (upstream webhook -> APX UpstreamWebhookController -> AckRegistry)`);
    } catch (e) {
      console.warn(`[ack] failed envelopeId=${envelopeId}: ${(e as Error).message}`);
    }
  } else {
    console.log(`[recv]   one-way activity, no ack requested (nothing sent back)`);
  }
}

async function respondToInvoke(
  conn: HubConnection,
  envelopeId: string,
  cv: string,
  payload: any,
  directive: string,
  recvAt: number
): Promise<void> {
  const base = { envelopeId, botKey: config.botKey, cv, recvAt };
  const value = g(payload, "value") || {};
  const name = g(payload, "name");

  // The reply body is the real Bot Framework invoke response for this invoke name — the same shape
  // the HTTP bot would return. The transport directive only governs timing / dup / error / drop.
  const reply = buildInvokeResponse(name, value);
  console.log(
    `[invoke] HANDLE name=${name} directive=${directive} -> computed status=${reply.status} ` +
      `body=${truncate(JSON.stringify(reply.body), 800)}`
  );

  switch (directive) {
    case "drop":
      console.log(`[invoke] DROP (no reply) name=${name} envelopeId=${envelopeId} -> expect APX timeout (InvokeRegistry TIMEOUT)`);
      return;

    case "delay": {
      const ms = Number(value.delayMs ?? value.DelayMs ?? 27000);
      console.log(`[invoke] DELAY ${ms}ms name=${name} envelopeId=${envelopeId} (tests APX invoke timeout deadline)`);
      await sleep(ms);
      await sendReply(conn, { ...base, status: reply.status, body: reply.body, ts: Date.now() });
      return;
    }

    case "error":
      console.log(`[invoke] ERROR directive name=${name} envelopeId=${envelopeId} -> replying status=500`);
      await sendReply(conn, {
        ...base,
        status: 500,
        body: { error: "bot handler error (test directive=error)" },
        ts: Date.now(),
      });
      return;

    case "dupe":
      console.log(`[invoke] DUPE directive name=${name} envelopeId=${envelopeId} -> sending reply TWICE (tests first-reply-wins dedup)`);
      await sendReply(conn, { ...base, status: reply.status, body: reply.body, ts: Date.now() });
      await sendReply(conn, { ...base, status: reply.status, body: reply.body, ts: Date.now() });
      return;

    case "ok":
    default:
      await sendReply(conn, { ...base, status: reply.status, body: reply.body, ts: Date.now() });
      return;
  }
}

async function sendReply(conn: HubConnection, frame: any): Promise<void> {
  try {
    console.log(
      `[reply] --> APX  invokeResponse envelopeId=${frame.envelopeId} status=${frame.status} ` +
        `body=${truncate(JSON.stringify(frame.body), 1200)}`
    );
    await conn.send("invokeResponse", frame);
    console.log(`[reply]   sent ok envelopeId=${frame.envelopeId} (upstream webhook -> APX UpstreamWebhookController)`);
  } catch (e) {
    console.warn(`[reply] send failed envelopeId=${frame.envelopeId}: ${(e as Error).message}`);
  }
}

function truncate(s: string | undefined, max = 800): string {
  if (s == null) {
    return "(none)";
  }
  return s.length <= max ? s : s.slice(0, max) + `...(+${s.length - max} chars)`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
