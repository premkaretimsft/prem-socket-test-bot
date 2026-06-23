# prem-socket-test-bot

Minimal **Azure SignalR socket-mode** test client for a local **APX** (bot API service)
instance. No Teams app, no extended markdown — it exists only to exercise APX bot socket
mode end-to-end, driven entirely by directives in the invoke payload.

## What it does

1. `POST /v3/websockets/connect` on the local APX BotNotifications role → `{ url, accessToken, sessionId, expiresIn }`.
2. Opens a SignalR WebSocket to the negotiated Azure SignalR `url` and joins the bot's group.
3. Receives APX→bot frames on the `activity` client method (a `SocketActivityEnvelope`),
   read case-insensitively (the Azure SignalR Management SDK may serialize PascalCase).
4. For **invokes** (`type:"invoke"`), replies over the socket with
   `connection.send("invokeResponse", frame)` — the correlation key is `envelopeId`.
5. For **ack-required** one-way activities, sends `connection.send("Ack", …)`.

## Run

```bash
cd prem-socket-test-bot
npm install
cp .env.example .env          # set BOT_KEY (= bot MSA AppId) and APX_BASE_URL
# local APX uses a dev cert; PowerShell:  $env:NODE_TLS_REJECT_UNAUTHORIZED = "0"
npm run build && npm start
# or: npm run dev
```

`.env`:

| var | meaning |
|---|---|
| `APX_BASE_URL` | local APX BotNotifications role, e.g. `https://localhost:444` (negotiate + invoke + upstream all live there) |
| `BOT_KEY` | the bot's MSA AppId — APX's socket key (group `bot_<BOT_KEY>`); echoed on replies |
| `CONNECTIONS` | parallel sockets for one bot (>1 exercises group-fanout duplicate delivery + dedup) |
| `DEFAULT_DIRECTIVE` | behavior when an invoke carries no `value.directive` |
| `RENEGOTIATE_FRACTION` | re-negotiate at this fraction of the token lifetime |

## Driving scenarios (directive-driven)

Per-invoke behavior comes from `payload.value.directive`, so the INT test that sends the
invoke picks the behavior:

| directive | bot behavior | exercises |
|---|---|---|
| `ok` | reply 200 + body | happy-path round-trip |
| `error` | reply 500 + error body | bot-error status passthrough |
| `dupe` | reply twice | APX first-reply-wins dedup |
| `delay` (`delayMs`, default 27000) | sleep then reply 200 | APX deadline → HTTP fallback |
| `drop` | no reply | timeout → HTTP fallback |

## Notes

- Requires **Node 18+** (uses global `fetch`).
- The reply body is a plain object (no bare string in an object-typed field) so a typed
  invoke-response client can deserialize it.
- Negotiate uses the DEBUG `?botKey=` override; for an authenticated run, swap in a Bot
  Framework JWT `Authorization: Bearer` header in `src/negotiate.ts`.
- *Fully real* path: the bot's `invokeResponse` / `Ack` sends travel
  client → Azure SignalR → **Upstream webhook** → APX, so APX's Azure SignalR resource must
  have its Upstream endpoint pointed at your APX URL (ngrok for local). See the APX bot
  socket-mode local E2E setup guide for the full walkthrough.
