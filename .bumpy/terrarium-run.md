---
"@saeris/terrarium": minor
---

`terrarium run "<command>"` runs a command, such as an app's dev server or its tests, inside the sandbox in one shell: its Node processes are preloaded with `@saeris/terrarium/register` and given `TERRARIUM_URL`, so they reach the sandbox at the network's own addresses. It uses the sandbox already running at `--url` and leaves it running, or starts one for the command (from `--dir`) and stops it when the command ends. `--unowned refuse` keeps the command off the network. The command's output is its own, Terrarium's one line goes to stderr, and `run` exits as the command did.
