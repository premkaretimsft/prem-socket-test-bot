// Minimal config for the socket-mode test bot. All values come from env
// (see .env.example). Nothing Teams-specific here — this bot exists only to
// exercise APX socket mode end-to-end against a local APX instance.

export const config = {
  // Base URL of the local APX BotNotifications role (the negotiate endpoint
  // /v3/websockets/connect, the invoke endpoint and the upstream webhook all live
  // there). 444 is the BotNotifications port in the standard local INT config
  // (BotNotificationsEndpoint); BotFrontEnd is 443. For the "fully real" setup this
  // is your local APX; the WSS URL itself is returned by negotiate (Azure SignalR).
  apxBaseUrl: process.env.APX_BASE_URL || "https://localhost:444",

  // The bot's MSA AppId. APX uses this as the socket "botKey" (group bot_{botKey})
  // and the bot echoes it back on replies. In a DEBUG local APX build the
  // negotiate endpoint accepts ?botKey=<this> without auth.
  botKey: process.env.BOT_KEY || "",

  // Re-negotiate at this fraction of the token lifetime (make-before-break-lite).
  renegotiateFraction: Number(process.env.RENEGOTIATE_FRACTION || 0.8),

  // Number of parallel socket connections to open (set >1 to exercise APX's
  // duplicate-reply dedup, since group fan-out delivers to every connection).
  connections: Number(process.env.CONNECTIONS || 1),

  // Behavior when an invoke carries no explicit directive in payload.value.directive.
  // One of: ok | error | delay | drop | dupe.
  defaultDirective: (process.env.DEFAULT_DIRECTIVE || "ok").toLowerCase(),
};
