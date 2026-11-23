import { passthrough } from "msw";
import { http, type HttpHandler } from "msw/http";
import { ws, type WebSocketHandler } from "msw/ws";
import { JETSTREAM_HOSTS } from "./hosts";
import { accept, SUBSCRIBE } from "./jetstream";
import { SUBSCRIBE_EVENTS } from "./jetstream-v2";
import type { Terrarium } from "./terrarium";

/**
 * Mock Service Worker handlers that hand Terrarium every request addressed to it: `plc.directory`, the accounts' PDSes at `*.terrarium.test`, their handles, DNS-over-HTTPS lookups of those handles, and Bluesky's Jetstream. The code under test keeps its real configuration and never learns the difference.
 *
 *     const server = setupServer(...handlers(terrarium), ...yourOwnHandlers);
 *     server.listen({ onUnhandledFrame: "error" });
 *
 * A request Terrarium doesn't own falls through to the handlers after these, or to `onUnhandledFrame`.
 */
export const handlers = (
  terrarium: Terrarium
): Array<HttpHandler | WebSocketHandler> => [
  // Terrarium talking to its own PDSes' runtimes, in this same process: not for the code under test to see, nor for MSW to stop.
  http.all(
    ({ request }) => terrarium.internal(request.url),
    () => passthrough()
  ),
  http.all(
    ({ request }) => terrarium.owns(request.url),
    async ({ request }) => terrarium.fetch(request)
  ),
  ...[...JETSTREAM_HOSTS].flatMap((host) =>
    [SUBSCRIBE, SUBSCRIBE_EVENTS].map((path) =>
      ws
        .link(`wss://${host}${path}`)
        .addEventListener("connection", ({ client }) => {
          const connection = accept(terrarium.jetstream, client.url, {
            send(frame) {
              client.send(frame);
            },
            close(code, reason) {
              client.close(code, reason);
            }
          });

          client.addEventListener("message", () => connection?.receive());
          client.addEventListener("close", () => connection?.close());
        })
    )
  )
];
