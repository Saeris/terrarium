---
"@saeris/terrarium": minor
---

`@saeris/terrarium/vite`: Terrarium as a Vite plugin, where an app says what sandbox it needs in `vite.config.ts`. `vite dev` brings it up with the accounts the plugin names, writes their records (replacing by rkey, every time, so the config stays what's there; a function is given the account, for records that name its DID), and points the dev server's own process at it, so server code reaches it at the network's own addresses. A sandbox already running is used and left running; one the dev server started lasts through restarts and stops when it closes. It stays out of `vite build`, `vite preview` and Vitest. `terrarium start` and `terrarium run` read the same options from the `vite.config.*` they run beside, or `--config`, with their flags winning.
