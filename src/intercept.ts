import { passthrough } from "msw";
import { http } from "msw/http";
import { setupServer } from "msw/node";
import { ws } from "msw/ws";
import * as v from "valibot";
import { PROXY_UNOWNED_HEADER, PROXY_URL_HEADER } from "./control";
import { SUBSCRIBE } from "./jetstream";
import { SUBSCRIBE_EVENTS } from "./jetstream-v2";
import {
  JETSTREAM_HOSTS,
  isHandleLookup,
  isLoopback,
  isSandboxAddress,
  refuse,
  type Unowned
} from "./hosts";

/**
 * This process, pointed at a running sandbox: every request it makes to the sandbox's addresses goes to the sandbox's control API, and Jetstream connections to its local Jetstream, while everything else goes where it always did, or, with `unowned: "refuse"`, fails unless it's to this machine. What `@saeris/terrarium/register` and the Vite plugin do to the process they're in.
 *
 * Interception is Mock Service Worker's. Once per process: a second call, such as the Vite plugin's in a dev server `terrarium run` already preloaded, leaves the first in place.
 */

export interface InterceptOptions {
  /** The sandbox's control API. */
  readonly control: string;
  readonly unowned: Unowned;
}

export interface Interception {
  /** Stop intercepting: the process's requests go where they were going again. */
  close(): void;
}

const ACTIVE = Symbol.for("@saeris/terrarium/intercept");

const outside = (url: URL): boolean =>
  !isSandboxAddress(url) && !isLoopback(url.hostname);

/** The part of an unhandled WebSocket frame that says where it was going. */
const socketFrameSchema = v.object({
  connection: v.object({ client: v.object({ url: v.instance(URL) }) })
});

export const intercept = async ({
  control,
  unowned
}: InterceptOptions): Promise<Interception> => {
  if (Reflect.get(globalThis, ACTIVE) === true) {
    return {
      close() {
        // The first interception is the one to close.
      }
    };
  }

  Reflect.set(globalThis, ACTIVE, true);

  try {
    const healthy = await fetch(`${control}/health`).catch((error: unknown) => {
      throw new Error(
        `Terrarium found no sandbox at ${control} (${String(error)}). Start one with \`terrarium start\`, or set TERRARIUM_URL.`,
        { cause: error }
      );
    });
    const { local } = v.parse(
      v.object({ local: v.object({ jetstream: v.string() }) }),
      await healthy.json()
    );

    const forward = async (request: Request): Promise<Response> => {
      const headers = new Headers(request.headers);

      headers.set(PROXY_URL_HEADER, request.url);

      const body =
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : await request.arrayBuffer();

      // To a local address no handler claims, so Mock Service Worker lets it through to the sandbox.
      return fetch(`${control}/_proxy`, {
        method: request.method,
        headers,
        redirect: "manual",
        ...(body !== undefined && { body })
      });
    };

    const server = setupServer(
      http.all(
        ({ request }) => isSandboxAddress(new URL(request.url)),
        async ({ request }) => forward(request)
      ),
      // A handle lookup at a real domain is the sandbox's only if one of its accounts holds that handle, which only the sandbox knows: ask it, and send the lookup on where it was going when the answer is no.
      http.all(
        ({ request }) => {
          const url = new URL(request.url);

          return isHandleLookup(url) && outside(url);
        },
        async ({ request }) => {
          const answer = await forward(request);

          if (!answer.headers.has(PROXY_UNOWNED_HEADER)) {
            return answer;
          }

          return unowned === "refuse"
            ? new Response(refuse(request.url), { status: 502 })
            : passthrough();
        }
      ),
      ...(unowned === "refuse"
        ? [
            http.all(
              ({ request }) => outside(new URL(request.url)),
              ({ request }) =>
                new Response(refuse(request.url), { status: 502 })
            )
          ]
        : []),
      ...[...JETSTREAM_HOSTS].flatMap((host) =>
        [SUBSCRIBE, SUBSCRIBE_EVENTS].map((path) =>
          ws
            .link(`wss://${host}${path}`)
            .addEventListener("connection", ({ client }) => {
              // The same path and query on the sandbox's own Jetstream port.
              const upstream = new WebSocket(
                new URL(
                  `${client.url.pathname}${client.url.search}`,
                  local.jetstream
                )
              );

              upstream.addEventListener(
                "message",
                (event: { data: unknown }) => {
                  client.send(String(event.data));
                }
              );
              // With the code and reason Jetstream gave, such as v2 refusing a cursor.
              upstream.addEventListener(
                "close",
                ({ code, reason }: { code: number; reason: string }) => {
                  if (code === 1005 || code === 1006) {
                    client.close();
                  } else {
                    client.close(code, reason);
                  }
                }
              );
              client.addEventListener("message", ({ data }) => {
                if (upstream.readyState === WebSocket.OPEN) {
                  upstream.send(data);
                } else {
                  upstream.addEventListener(
                    "open",
                    () => {
                      upstream.send(data);
                    },
                    { once: true }
                  );
                }
              });
              client.addEventListener("close", () => {
                upstream.close();
              });
            })
        )
      )
    );

    server.listen({
      // Anything left over is let through, except, when refusing, a WebSocket leaving the machine: throwing here fails it.
      onUnhandledFrame: ({ frame }) => {
        if (unowned !== "refuse" || frame.protocol !== "ws") {
          return;
        }

        const { url } = v.parse(socketFrameSchema, frame.data).connection
          .client;

        if (outside(url)) {
          throw new Error(refuse(url));
        }
      }
    });

    return {
      close() {
        server.close();
        Reflect.set(globalThis, ACTIVE, false);
      }
    };
  } catch (error) {
    Reflect.set(globalThis, ACTIVE, false);
    throw error;
  }
};
