---
"@saeris/terrarium": minor
---

Jetstream from inside a Worker. With `outbound(terrarium)` as its `outboundService`, a Worker or Durable Object that opens a WebSocket to Bluesky's Jetstream (`fetch(url, { headers: { upgrade: "websocket" } })`) gets the sandbox's, with its `wantedDids`, `wantedCollections` and `cursor`, so an AppView that catches up on a schedule runs under Miniflare unchanged. A socket to anything else Terrarium owns is closed straight away with code 1011 and a reason, rather than left open and silent.
