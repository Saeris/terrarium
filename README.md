<div align="center">

# 🪴 Terrarium

[![npm version][npm_badge]][npm]
[![CI status][ci_badge]][ci]

An Atmosphere in a box: a PLC directory and as many PDSes as you need on your machine, for developing and testing ATProto apps without touching the network.

</div>

---

Every account is a real `did:plc`, registered with a local PLC directory that enforces the same rules as `plc.directory`, on its own [Cirrus](https://github.com/ascorbic/cirrus) PDS running on `workerd`, the runtime Cloudflare runs it on. A Jetstream follows every PDS's firehose. Nothing it does leaves your machine, no DID reaches the public directory, and everything survives a restart.

**It's invisible to the code under test**, as [Mock Service Worker](https://mswjs.io) is. Terrarium answers at the addresses the network uses, and an interceptor hands it the requests:

| Address                                                                                                         | Answered by                                      |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `https://plc.directory`                                                                                         | Terrarium's PLC directory                        |
| `https://<name>.terrarium.test`                                                                                 | that account's PDS, as its DID document names it |
| `https://<handle>/.well-known/atproto-did`, and `_atproto` TXT lookups over DNS-over-HTTPS (Cloudflare, Google) | the account's DID                                |
| `wss://jetstream{1,2}.us-{east,west}.bsky.network/subscribe`                                                    | Terrarium's Jetstream                            |

So an app keeps its real configuration: atcute's resolvers with their defaults, Bluesky's Jetstream URL, a PDS from a DID document. Any other `.test` host is Terrarium's too, and gets a 502, so nothing aimed at the sandbox can leak.

## 📦 Installation

```bash
vp add -D @saeris/terrarium
```

## 🔧 Usage

### In tests, with Mock Service Worker

```ts
import { setupServer } from "msw/node";
import { createTerrarium } from "@saeris/terrarium";
import { handlers } from "@saeris/terrarium/msw";

const terrarium = await createTerrarium(); // in memory; pass { dir } to keep it
const alice = await terrarium.createAccount({ name: "alice" });
const server = setupServer(...handlers(terrarium), ...yourOwnHandlers);

server.listen({ onUnhandledFrame: "error" });

// Your code, unchanged: resolves alice's DID at plc.directory, signs in at https://alice.terrarium.test, follows Jetstream.
```

Requests Terrarium doesn't own fall through to your handlers. Its own traffic to its PDS runtimes is let through.

### In a browser, with Playwright

```ts
import { route } from "@saeris/terrarium/playwright";

await route(context, terrarium); // a BrowserContext or a Page
await page.goto("https://your.app/");
```

Every request a page makes to Terrarium's addresses is answered by the sandbox, including top-level navigations, so an OAuth redirect lands on the account's PDS sign-in page. Jetstream is answered over WebSocket. No TLS or DNS is involved: Playwright hands the request over before it reaches the network.

### From the command line

Start a sandbox, and leave it running:

```bash
terrarium start                       # keeps its state in ./.terrarium
```

At a terminal it prints a summary. Run from a script or by an agent, it prints one line of JSON once it's ready, with the control API's, the PLC directory's and Jetstream's URLs and every account.

Then, from another shell, make accounts as you need them and fill them with records. Every command prints JSON, and `terrarium --help` (or `--help` after any command) says what it takes.

```bash
terrarium accounts create alice       # alice.test, password "password"
terrarium accounts create bob --handle bob.example.test --password hunter2
terrarium seed alice fixtures.json    # or pipe them in: terrarium seed alice -
terrarium accounts                    # DIDs, handles, PDS URLs and passwords
```

An account comes back as:

```json
{
  "name": "alice",
  "did": "did:plc:utpe647yoe7vjt5uihb5kpuj",
  "handle": "alice.test",
  "endpoint": "https://alice.terrarium.test",
  "local": "http://127.0.0.1:2600",
  "password": "password"
}
```

A running sandbox also answers on local ports, for clients nothing intercepts, such as `curl`: each PDS at its `local` address, the PLC directory at `http://127.0.0.1:2582` and Jetstream at `ws://127.0.0.1:2584/subscribe`. Signing in with the password works (`com.atproto.server.createSession`).

### Jetstream

The same events and query parameters as Bluesky's Jetstream (`wantedDids`, `wantedCollections` with `.*` prefixes, and a microsecond `cursor` to replay from), fed straight from every PDS's firehose. It keeps the last 10,000 events for replaying; its history starts empty after a restart.

It can also misbehave on purpose, as a real relay does, so you can test what your app does about it:

```bash
terrarium jetstream pause             # hold every event back, as a relay that has fallen behind
terrarium jetstream resume            # deliver what was held back
terrarium jetstream ignore alice      # never carry alice's events, as a relay that drops her PDS
terrarium jetstream heed alice        # carry them again (what was missed stays missed)
terrarium jetstream                   # what's switched on
```

### Seeding

A seed file is a list of records, or an object with a `records` list. `$type` defaults to the collection, and a record without an `rkey` gets a TID. A record whose `rkey` is already in the repo is replaced, so a fixture can be changed and applied again.

```json
{
  "records": [
    {
      "collection": "app.bsky.actor.profile",
      "rkey": "self",
      "record": { "displayName": "Alice" }
    },
    { "collection": "com.example.note", "record": { "text": "hello" } }
  ]
}
```

### The control API

The CLI is a thin client for the running sandbox's control API on `http://127.0.0.1:2580`, which `curl` can use as well:

| Request                                         | Does                                                        |
| ----------------------------------------------- | ----------------------------------------------------------- |
| `GET /accounts`                                 | Every account                                               |
| `POST /accounts` `{ name, handle?, password? }` | A new account on its own PDS                                |
| `GET /accounts/:name`                           | One account                                                 |
| `POST /accounts/:name/records`                  | Seed records, as in a seed file                             |
| `GET /jetstream`                                | Which faults are switched on                                |
| `POST /jetstream/pause`, `/jetstream/resume`    | Hold events back, then release them                         |
| `POST /jetstream/ignore/:name`, `/heed/:name`   | Stop, then start, carrying an account                       |
| `GET /health`                                   | The PLC and Jetstream URLs, and how many accounts there are |

### Without an interceptor

The sandbox can also be called directly, with no ports open: every service is reached through its `fetch`.

```ts
import { createTerrarium } from "@saeris/terrarium";

const terrarium = await createTerrarium(); // in memory; pass { dir } to keep it
const alice = await terrarium.createAccount({ name: "alice" });

await terrarium.seed("alice", [
  { collection: "com.example.note", record: { text: "hi" } }
]);

const response = await terrarium.fetch(
  new Request(
    `${alice.endpoint}/xrpc/com.atproto.repo.listRecords?repo=${alice.did}&collection=com.example.note`
  )
);

await terrarium.dispose();
```

Hand `terrarium.fetch` to a client that accepts a custom `fetch`, and `terrarium.connect` to one that takes a function to open a WebSocket. `terrarium.owns(url)` says which addresses are the sandbox’s, for wiring up another interceptor; requests to anything else are refused with a 502, never sent to the network. `terrarium.jetstream` has the same fault switches as the CLI.

## 🎛 Configuration

| Option                             | CLI      | Default                                                        |
| ---------------------------------- | -------- | -------------------------------------------------------------- |
| State directory                    | `--dir`  | `.terrarium` (in memory for `createTerrarium()` without `dir`) |
| Host every service is addressed by | `--host` | `127.0.0.1`                                                    |
| Control API port                   | `--port` | `2580`                                                         |
| PLC directory port                 |          | `2582`                                                         |
| Jetstream port                     |          | `2584`                                                         |
| First PDS port                     |          | `2600`, then one more per account                              |

Add your state directory to `.gitignore`: it holds every account's keys and password.

## 🚧 Not yet

- **Apps on Workers.** An app running under Miniflare or `wrangler dev` makes its requests from `workerd`, where neither interceptor reaches; Miniflare's `outboundService` is the way in.
- **The reference PDS** as a second engine, for accounts that must behave exactly like bsky.social's, and for atproto spaces once their beta lands.
- **Node's own DNS.** `_atproto` TXT lookups through `node:dns` aren't intercepted, only DNS-over-HTTPS and `/.well-known/atproto-did`.
- **Other Bluesky services**, such as the AppView's `public.api.bsky.app`.

## 🤝 Contributing

The project uses [Vite+][viteplus] as a unified toolchain (Oxlint + Oxfmt + tsdown + Vitest) and [Bumpy][bumpy] for versioning and release.

```bash
vp install           # install dependencies
vp check --fix       # format + lint + typecheck (with autofixes)
vp test              # run Vitest
yarn bumpy add       # create a bump file for your PR
```

## 📣 Acknowledgements

- [Cirrus](https://github.com/ascorbic/cirrus) by Matt Kane, the PDS every account runs on.
- [atcute](https://github.com/mary-ext/atcute) by Mary, for `did:plc` operations and keys.
- [Atmosphere in a Box](https://tangled.org/kandake.africa/atmosphereinabox/), whose lessons about running the Atmosphere locally shaped this one.
- [tinbase](https://github.com/tinbase/tinbase), for the shape: one process, real implementations, an in-process mode for tests.

## 🥂 License

Released under the [MIT license][license] © [Drake Costa][personal-website].

[npm_badge]: https://img.shields.io/npm/v/@saeris/terrarium.svg?style=flat
[npm]: https://www.npmjs.com/package/@saeris/terrarium
[ci_badge]: https://github.com/Saeris/terrarium/actions/workflows/ci.yml/badge.svg
[ci]: https://github.com/Saeris/terrarium/actions/workflows/ci.yml
[viteplus]: https://viteplus.dev/
[bumpy]: https://bumpy.varlock.dev/
[license]: ./LICENSE.md
[personal-website]: https://saeris.gg
