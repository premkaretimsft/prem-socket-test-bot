import { config } from "./config";

export interface NegotiateResult {
  url: string;
  accessToken: string;
  sessionId: string;
  expiresIn: number; // seconds
}

// POST {apxBaseUrl}/v3/websockets/connect.
// DEBUG local APX honors ?botKey=<MsaAppId> when the request is unauthenticated,
// which is all this test bot needs. (For an authenticated run, replace this with
// a Bearer Bot Framework JWT and drop the query param.)
export async function negotiate(): Promise<NegotiateResult> {
  const u = new URL("/v3/websockets/connect", config.apxBaseUrl);
  if (config.botKey) {
    u.searchParams.set("botKey", config.botKey);
  }

  const res = await fetch(u.toString(), {
    method: "POST",
    headers: { "content-length": "0" },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`negotiate failed: HTTP ${res.status} ${body}`);
  }

  const json = (await res.json()) as NegotiateResult;
  if (!json.url || !json.accessToken) {
    throw new Error("negotiate response missing url/accessToken");
  }
  return json;
}
