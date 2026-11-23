import * as v from "valibot";
import { intercept } from "./intercept";

/**
 * Terrarium in another Node process, such as an app's dev server: preload this, and every request that process makes to the sandbox's addresses goes to a running sandbox (`terrarium start`), while everything else goes where it always did, or, with `TERRARIUM_UNOWNED=refuse`, fails unless it's to this machine.
 *
 *     TERRARIUM_URL=http://127.0.0.1:2580 node --import @saeris/terrarium/register server.js
 *
 * Interception is Mock Service Worker's, in that process; the requests are forwarded to the sandbox's control API, and Jetstream connections to its local Jetstream.
 */

await intercept({
  control: process.env["TERRARIUM_URL"] ?? "http://127.0.0.1:2580",
  unowned: v.parse(
    v.optional(v.picklist(["network", "refuse"]), "network"),
    process.env["TERRARIUM_UNOWNED"]
  )
});
