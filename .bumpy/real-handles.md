---
"@saeris/terrarium": minor
---

Accounts at real domains. `createAccount({ name, handle: "example.com" })` (or `terrarium accounts create site --handle example.com`) makes an account whose handle lookups, `https://example.com/.well-known/atproto-did` and its `_atproto` DNS-over-HTTPS record, every interceptor answers with the account's DID, so an app that finds its main account by handle finds the sandbox's without being configured to. Nothing else at the domain is touched: the preload in another process asks the sandbox about each handle lookup and sends the ones it doesn't hold on to the network, or refuses them with `TERRARIUM_UNOWNED=refuse`. Handles are checked as domain names and lowercased, and no two accounts can share one.
