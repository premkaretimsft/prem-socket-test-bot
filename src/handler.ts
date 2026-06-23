import { HubConnection } from "@microsoft/signalr";
import { config } from "./config";

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
  const type = g(env, "type");
  const payload = g(env, "payload") || {};
  const envelopeId = g(env, "envelopeId");
  const cv = g(env, "cv");
  const isInvoke = type === "invoke" || g(payload, "type") === "invoke";

  console.log(
    `[recv] type=${type} envelopeId=${envelopeId} cv=${cv} ` +
      `payloadType=${g(payload, "type")} name=${g(payload, "name")} isInvoke=${isInvoke}`
  );

  if (isInvoke) {
    const value = g(payload, "value") || {};
    const directive = String(value.directive ?? value.Directive ?? config.defaultDirective).toLowerCase();
    await respondToInvoke(conn, envelopeId, cv, payload, directive);
    return;
  }

  // One-way activity. Send a fire-and-forget Ack only if APX asked for one.
  if (g(env, "ackRequired")) {
    try {
      await conn.send("Ack", { envelopeId, botKey: config.botKey, ts: Date.now() });
      console.log(`[ack] sent envelopeId=${envelopeId}`);
    } catch (e) {
      console.warn(`[ack] failed envelopeId=${envelopeId}: ${(e as Error).message}`);
    }
  }
}

async function respondToInvoke(
  conn: HubConnection,
  envelopeId: string,
  cv: string,
  payload: any,
  directive: string
): Promise<void> {
  const base = { envelopeId, botKey: config.botKey, cv, recvAt: Date.now() };
  const value = g(payload, "value") || {};

  switch (directive) {
    case "drop":
      console.log(`[invoke] DROP (no reply) envelopeId=${envelopeId} -> expect APX timeout`);
      return;

    case "delay": {
      const ms = Number(value.delayMs ?? value.DelayMs ?? 27000);
      console.log(`[invoke] DELAY ${ms}ms envelopeId=${envelopeId}`);
      await sleep(ms);
      await sendReply(conn, { ...base, status: 200, body: okBody(payload), ts: Date.now() });
      return;
    }

    case "error":
      await sendReply(conn, {
        ...base,
        status: 500,
        body: { error: "bot handler error (test directive=error)" },
        ts: Date.now(),
      });
      return;

    case "dupe":
      await sendReply(conn, { ...base, status: 200, body: okBody(payload), ts: Date.now() });
      await sendReply(conn, { ...base, status: 200, body: okBody(payload), ts: Date.now() });
      return;

    case "ok":
    default:
      await sendReply(conn, { ...base, status: 200, body: okBody(payload), ts: Date.now() });
      return;
  }
}

async function sendReply(conn: HubConnection, frame: any): Promise<void> {
  try {
    await conn.send("invokeResponse", frame);
    console.log(`[invoke] replied status=${frame.status} envelopeId=${frame.envelopeId}`);
  } catch (e) {
    console.warn(`[invoke] reply send failed envelopeId=${frame.envelopeId}: ${(e as Error).message}`);
  }
}

function okBody(payload: any) {
  const name = g(payload, "name") || "invoke";
  // Keep the body a plain object with only string/number leaves so the typed INT
  // client can deserialize it as a V2InvokeResponse without a type conflict (do NOT
  // put a bare string in a field that maps to an object DTO property such as "value").
  return {
    statusCode: 200,
    source: "prem-socket-test-bot",
    echoedName: name,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
