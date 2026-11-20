import { createServer } from "node:http";
import { buffer } from "node:stream/consumers";
import { WebSocketServer, type WebSocket } from "ws";

/** A `fetch` handler on a socket, for the parts of Terrarium that aren't already listening (the control API, the PLC directory, Jetstream). */

export interface Listening {
  readonly url: string;
  close(): Promise<void>;
}

export interface ServeOptions {
  readonly host: string;
  readonly port: number;
  /** Accept WebSocket upgrades, and hand each socket over with the URL it was opened with. */
  readonly upgrade?: (url: URL, socket: WebSocket) => void;
}

export const serve = async (
  handler: (request: Request) => Promise<Response>,
  { host, port, upgrade }: ServeOptions
): Promise<Listening> => {
  const origin = `http://${host}:${String(port)}`;
  const sockets = upgrade && new WebSocketServer({ noServer: true });
  const server = createServer((incoming, outgoing) => {
    void (async (): Promise<void> => {
      const headers = new Headers();

      for (const [name, value] of Object.entries(incoming.headers)) {
        for (const each of [value ?? []].flat()) {
          headers.append(name, each);
        }
      }

      const hasBody = incoming.method !== "GET" && incoming.method !== "HEAD";
      const response = await handler(
        new Request(`${origin}${incoming.url ?? "/"}`, {
          method: incoming.method ?? "GET",
          headers,
          ...(hasBody && { body: await buffer(incoming) })
        })
      ).catch(
        (error: unknown) =>
          new Response(error instanceof Error ? error.message : String(error), {
            status: 500
          })
      );

      outgoing.writeHead(response.status, [...response.headers].flat());
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    })();
  });

  if (sockets) {
    server.on("upgrade", (incoming, stream, head) => {
      sockets.handleUpgrade(incoming, stream, head, (socket) => {
        upgrade(new URL(incoming.url ?? "/", origin), socket);
      });
    });
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });

  return {
    url: origin,
    close: async () =>
      new Promise<void>((resolve) => {
        // Open sockets would hold the server open forever.
        for (const socket of sockets?.clients ?? []) {
          socket.terminate();
        }

        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      })
  };
};
