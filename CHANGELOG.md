# Changelog





## 0.4.1
<sub>2026-11-25</sub>

- [#7](https://github.com/Saeris/terrarium/pull/7)  *(patch)* Thanks [@Saeris](https://github.com/Saeris)!
  `route` keeps a page's fragment through a redirect, as a browser does: a navigation to `/devices#device_token=…` that a static host sends on to `/devices/` lands at `/devices/#device_token=…`. It dropped it before, so an app that hands a credential over in a fragment lost it to the first trailing-slash redirect. A redirect that names a fragment of its own still goes there.

## 0.4.0
<sub>2026-11-23</sub>

- [#5](https://github.com/Saeris/terrarium/pull/5)  *(minor)* Thanks [@Saeris](https://github.com/Saeris)!
  `signIn(page, account)` from `@saeris/terrarium/playwright` signs an account in on its PDS's own sign-in and consent page, as a person would, once the app under test has sent the page there: it types the account's password, presses Allow, and resolves when the PDS sends the page back to the app. When the PDS won't let it through (a wrong password, a client it couldn't resolve, permissions it can't show), it throws with what the page says instead of leaving the test to time out. Tested with a real OAuth client (`@atcute/oauth-node-client`) through the whole round trip: PAR, sign-in, consent, the callback, the token exchange, and a DPoP-bound write as the account.
- [#5](https://github.com/Saeris/terrarium/pull/5)  *(minor)* Thanks [@Saeris](https://github.com/Saeris)!
  `terrarium run "<command>"` runs a command, such as an app's dev server or its tests, inside the sandbox in one shell: its Node processes are preloaded with `@saeris/terrarium/register` and given `TERRARIUM_URL`, so they reach the sandbox at the network's own addresses. It uses the sandbox already running at `--url` and leaves it running, or starts one for the command (from `--dir`) and stops it when the command ends. `--unowned refuse` keeps the command off the network. The command's output is its own, Terrarium's one line goes to stderr, and `run` exits as the command did.
- [#5](https://github.com/Saeris/terrarium/pull/5)  *(minor)* Thanks [@Saeris](https://github.com/Saeris)!
  `@saeris/terrarium/vite`: Terrarium as a Vite plugin, where an app says what sandbox it needs in `vite.config.ts`. `vite dev` brings it up with the accounts the plugin names, writes their records (replacing by rkey, every time, so the config stays what's there; a function is given the account, for records that name its DID), and points the dev server's own process at it, so server code reaches it at the network's own addresses. A sandbox already running is used and left running; one the dev server started lasts through restarts and stops when it closes. It stays out of `vite build`, `vite preview` and Vitest. `terrarium start` and `terrarium run` read the same options from the `vite.config.*` they run beside, or `--config`, with their flags winning.
- [#5](https://github.com/Saeris/terrarium/pull/5)  *(minor)* Thanks [@Saeris](https://github.com/Saeris)!
  Jetstream's v2 stream, `/xrpc/network.bsky.jetstream.subscribeEvents`, beside `/subscribe` on every way into the sandbox: Mock Service Worker, Playwright, Miniflare's outbound, the local port and the preload. It frames events as the lexicon does, numbers them with a `seq` to resume from inclusively (or a time in microseconds, clamped with `OutdatedCursor`, or past the tip with `FutureCursor`), filters by `kinds`, `dids` and `collections`, and refuses what Bluesky's refuses (`CursorTooOld`, v1's parameter names, and the rest) by closing the socket with code 1008 and the error as its reason. Compression, `maxMessageSizeBytes` and `#sync` events aren't emulated. A Jetstream listener is now also given each event's seq, and `connect`'s socket has `send`, and passes `onclose` the code and reason.

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
