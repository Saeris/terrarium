---
"@saeris/terrarium": minor
---

Jetstream's v2 stream, `/xrpc/network.bsky.jetstream.subscribeEvents`, beside `/subscribe` on every way into the sandbox: Mock Service Worker, Playwright, Miniflare's outbound, the local port and the preload. It frames events as the lexicon does, numbers them with a `seq` to resume from inclusively (or a time in microseconds, clamped with `OutdatedCursor`, or past the tip with `FutureCursor`), filters by `kinds`, `dids` and `collections`, and refuses what Bluesky's refuses (`CursorTooOld`, v1's parameter names, and the rest) by closing the socket with code 1008 and the error as its reason. Compression, `maxMessageSizeBytes` and `#sync` events aren't emulated. A Jetstream listener is now also given each event's seq, and `connect`'s socket has `send`, and passes `onclose` the code and reason.
