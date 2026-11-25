---
"@saeris/terrarium": patch
---

`route` keeps a page's fragment through a redirect, as a browser does: a navigation to `/devices#device_token=…` that a static host sends on to `/devices/` lands at `/devices/#device_token=…`. It dropped it before, so an app that hands a credential over in a fragment lost it to the first trailing-slash redirect. A redirect that names a fragment of its own still goes there.
