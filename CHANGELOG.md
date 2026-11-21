# Changelog



## 0.3.0
<sub>2026-11-21</sub>

- [#3](https://github.com/Saeris/terrarium/pull/3)  *(minor)* Thanks [@Saeris](https://github.com/Saeris)!
  Jetstream from inside a Worker. With `outbound(terrarium)` as its `outboundService`, a Worker or Durable Object that opens a WebSocket to Bluesky's Jetstream (`fetch(url, { headers: { upgrade: "websocket" } })`) gets the sandbox's, with its `wantedDids`, `wantedCollections` and `cursor`, so an AppView that catches up on a schedule runs under Miniflare unchanged. A socket to anything else Terrarium owns is closed straight away with code 1011 and a reason, rather than left open and silent.

## 0.2.0
<sub>2026-11-20</sub>

-  *(minor)*
  Accounts at real domains. `createAccount({ name, handle: "example.com" })` (or `terrarium accounts create site --handle example.com`) makes an account whose handle lookups, `https://example.com/.well-known/atproto-did` and its `_atproto` DNS-over-HTTPS record, every interceptor answers with the account's DID, so an app that finds its main account by handle finds the sandbox's without being configured to. Nothing else at the domain is touched: the preload in another process asks the sandbox about each handle lookup and sends the ones it doesn't hold on to the network, or refuses them with `TERRARIUM_UNOWNED=refuse`. Handles are checked as domain names and lowercased, and no two accounts can share one.

## 0.1.0
<sub>2026-11-20</sub>

-  *(minor)*
  The first release: an Atmosphere in a box, for developing and testing ATProto apps on your machine without touching the network.

  - A PLC directory that enforces `plc.directory`'s rules, as many accounts as you need, each a real `did:plc` on its own [Cirrus](https://github.com/ascorbic/cirrus) PDS running on `workerd`, and a Jetstream following every PDS's firehose, with switches to pause it or drop an account as a misbehaving relay would.
  - Transparent, as Mock Service Worker is: apps keep their real configuration, and Terrarium answers `plc.directory`, `https://<name>.terrarium.test` PDSes, handle resolution over HTTPS and DNS-over-HTTPS, Bluesky's Jetstream hosts and the parts of Bluesky's AppView apps use to find accounts.
  - Interceptors for every place an app runs: `@saeris/terrarium/msw` in tests, `@saeris/terrarium/playwright` in a browser (OAuth redirects included), `@saeris/terrarium/register` in another Node process such as a dev server, and `@saeris/terrarium/miniflare` and `@saeris/terrarium/wrangler` for Workers.
  - Each interceptor can refuse what Terrarium doesn't own, to prove a test never leaves the sandbox.
  - A `terrarium` CLI and a JSON control API to start a sandbox, make accounts and seed them with records, built for agents as well as people.
