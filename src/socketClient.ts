import {
  HubConnection,
  HubConnectionBuilder,
  LogLevel,
} from "@microsoft/signalr";
import { negotiate } from "./negotiate";

// Builds a SignalR hub connection to the negotiated Azure SignalR URL and wires
// the inbound "activity" client method (APX -> bot). Returns the live connection
// and its token lifetime so the caller can schedule a re-negotiate.
//
// APX sends every inbound frame as the client method "activity" with a single
// SocketActivityEnvelope argument (see SocketModeDispatcher / SocketInvokeDispatcher).
export async function buildConnection(
  label: string,
  onActivity: (conn: HubConnection, envelope: any) => void
): Promise<{ connection: HubConnection; expiresIn: number; sessionId: string }> {
  const neg = await negotiate();

  const conn = new HubConnectionBuilder()
    .withUrl(neg.url, { accessTokenFactory: () => neg.accessToken })
    .withAutomaticReconnect([0, 2000, 5000, 10000, 20000])
    .configureLogging(LogLevel.Warning)
    .build();

  conn.on("activity", (envelope: any) => onActivity(conn, envelope));
  conn.onreconnecting((e) => console.warn(`[${label}] reconnecting: ${e?.message ?? ""}`));
  conn.onreconnected((id) => console.log(`[${label}] reconnected: ${id ?? ""}`));
  conn.onclose((e) => console.warn(`[${label}] closed: ${e?.message ?? ""}`));

  await conn.start();
  console.log(`[${label}] connected. sessionId=${neg.sessionId} expiresIn=${neg.expiresIn}s`);
  return { connection: conn, expiresIn: neg.expiresIn, sessionId: neg.sessionId };
}
