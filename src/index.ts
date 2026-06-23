import { config } from "./config";
import { buildConnection } from "./socketClient";
import { handleEnvelope } from "./handler";
import type { HubConnection } from "@microsoft/signalr";

// Keeps one socket connection alive forever: SignalR's auto-reconnect covers
// transient drops; this loop handles token expiry by re-negotiating + rebuilding
// at renegotiateFraction of the token lifetime.
async function manageConnection(label: string): Promise<void> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let conn: HubConnection | undefined;
    try {
      const { connection, expiresIn } = await buildConnection(label, (c, env) => {
        void handleEnvelope(c, env);
      });
      conn = connection;

      const waitMs = Math.max(60, expiresIn * config.renegotiateFraction) * 1000;
      await sleep(waitMs);
      console.log(`[${label}] token near expiry -> re-negotiating`);
    } catch (e) {
      console.error(`[${label}] connection error, retrying in 5s: ${(e as Error).message}`);
      await sleep(5000);
    } finally {
      try {
        await conn?.stop();
      } catch {
        /* ignore */
      }
    }
  }
}

async function main(): Promise<void> {
  if (!config.botKey) {
    console.error("BOT_KEY is required (the bot's MSA AppId). Set it in .env. Exiting.");
    process.exit(1);
  }

  console.log(
    `prem-socket-test-bot starting. apx=${config.apxBaseUrl} botKey=${config.botKey} ` +
      `connections=${config.connections} defaultDirective=${config.defaultDirective}`
  );

  const labels = Array.from({ length: Math.max(1, config.connections) }, (_, i) => `conn${i + 1}`);
  await Promise.all(labels.map((l) => manageConnection(l)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

process.on("SIGINT", () => {
  console.log("\nShutting down.");
  process.exit(0);
});

void main();
