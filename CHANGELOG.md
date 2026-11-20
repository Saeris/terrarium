# Changelog

## 0.1.0
<sub>2026-11-20</sub>

-  *(minor)*
  The first release: an Atmosphere in a box, for developing and testing ATProto apps on your machine without touching the network.

  - A PLC directory that enforces `plc.directory`'s rules, as many accounts as you need, each a real `did:plc` on its own [Cirrus](https://github.com/ascorbic/cirrus) PDS running on `workerd`, and a Jetstream following every PDS's firehose, with switches to pause it or drop an account as a misbehaving relay would.
  - Transparent, as Mock Service Worker is: apps keep their real configuration, and Terrarium answers `plc.directory`, `https://<name>.terrarium.test` PDSes, handle resolution over HTTPS and DNS-over-HTTPS, Bluesky's Jetstream hosts and the parts of Bluesky's AppView apps use to find accounts.
  - Interceptors for every place an app runs: `@saeris/terrarium/msw` in tests, `@saeris/terrarium/playwright` in a browser (OAuth redirects included), `@saeris/terrarium/register` in another Node process such as a dev server, and `@saeris/terrarium/miniflare` and `@saeris/terrarium/wrangler` for Workers.
  - Each interceptor can refuse what Terrarium doesn't own, to prove a test never leaves the sandbox.
  - A `terrarium` CLI and a JSON control API to start a sandbox, make accounts and seed them with records, built for agents as well as people.
