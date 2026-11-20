import { http } from "msw/http";
import { setupServer } from "msw/node";
import { ws } from "msw/ws";
import * as v from "valibot";
import { PROXY_URL_HEADER } from "./control";
import { JETSTREAM_HOSTS, isLoopback, isSandboxAddress, refuse } from "./hosts";

/**
 * Terrarium in another Node process, such as an app's dev server: preload this, and every request that process makes to the sandbox's addresses goes to a running sandbox (`terrarium start`), while everything else goes where it always did, or, with `TERRARIUM_UNOWNED=refuse`, fails unless it's to this machine.
 *
 *     TERRARIUM_URL=http://127.0.0.1:2580 node --import @saeris/terrarium/register server.js
 *
 * Interception is Mock Service Worker's, in that process; the requests are forwarded to the sandbox's control API, and Jetstream connections to its local Jetstream.
 */

const control = process.env["TERRARIUM_URL"] ?? "http://127.0.0.1:2580";
const unowned = v.parse(
  v.optional(v.picklist(["network", "refuse"]), "network"),
  process.env["TERRARIUM_UNOWNED"]
);

const outside = (url: URL): boolean =>
  !isSandboxAddress(url) && !isLoopback(url.hostname);

/** The part of an unhandled WebSocket frame that says where it was going. */
const socketFrameSchema = v.object({
  connection: v.object({ client: v.object({ url: v.instance(URL) }) })
});

const healthy = await fetch(`${control}/health`).catch((error: unknown) => {
  throw new Error(
    `@saeris/terrarium/register found no sandbox at ${control} (${String(error)}). Start one with \`terrarium start\`, or set TERRARIUM_URL.`,
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
  ...(unowned === "refuse"
    ? [
        http.all(
          ({ request }) => outside(new URL(request.url)),
          ({ request }) => new Response(refuse(request.url), { status: 502 })
        )
      ]
    : []),
  ...[...JETSTREAM_HOSTS].map((host) =>
    ws
      .link(`wss://${host}/subscribe`)
      .addEventListener("connection", ({ client }) => {
        const upstream = new WebSocket(
          `${local.jetstream}${client.url.search}`
        );

        upstream.addEventListener("message", (event: { data: unknown }) => {
          client.send(String(event.data));
        });
        upstream.addEventListener("close", () => {
          client.close();
        });
        client.addEventListener("close", () => {
          upstream.close();
        });
      })
  )
);

server.listen({
  // Anything left over is let through, except, when refusing, a WebSocket leaving the machine: throwing here fails it.
  onUnhandledFrame: ({ frame }) => {
    if (unowned !== "refuse" || frame.protocol !== "ws") {
      return;
    }

    const { url } = v.parse(socketFrameSchema, frame.data).connection.client;

    if (outside(url)) {
      throw new Error(refuse(url));
    }
  }
});
