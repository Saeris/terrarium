---
"@saeris/terrarium": minor
---

`signIn(page, account)` from `@saeris/terrarium/playwright` signs an account in on its PDS's own sign-in and consent page, as a person would, once the app under test has sent the page there: it types the account's password, presses Allow, and resolves when the PDS sends the page back to the app. When the PDS won't let it through (a wrong password, a client it couldn't resolve, permissions it can't show), it throws with what the page says instead of leaving the test to time out. Tested with a real OAuth client (`@atcute/oauth-node-client`) through the whole round trip: PAR, sign-in, consent, the callback, the token exchange, and a DPoP-bound write as the account.
