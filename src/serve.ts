import { createServer } from "node:http";
import { buffer } from "node:stream/consumers";

/** A `fetch` handler on a socket, for the parts of Terrarium that aren't already listening (the control API, the PLC directory). */

export interface Listening {
  readonly url: string;
  close(): Promise<void>;
}

export const serve = async (
  handler: (request: Request) => Promise<Response>,
  { host, port }: { readonly host: string; readonly port: number }
): Promise<Listening> => {
  const origin = `http://${host}:${String(port)}`;
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

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });

  return {
    url: origin,
    close: async () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      })
  };
};
