import {
  type Miniflare,
  type Request as WorkerRequest,
  Response as WorkerResponse,
  WebSocketPair
} from "miniflare";
import {
  fromWorker,
  responseFromWorker,
  responseToWorker,
  toWorker
} from "./bridge";
import { refuse, type Unowned } from "./hosts";
import type { Terrarium } from "./terrarium";

/**
 * Terrarium as a Worker's network. A Worker under Miniflare makes its requests from `workerd`, where neither Mock Service Worker nor Playwright reaches; Miniflare's `outboundService` is the way in. Pass this as it, and the Worker's requests to `plc.directory`, PDSes, handles and the rest are answered by the sandbox.
 *
 *     new Miniflare({ ...workerOptions, outboundService: outbound(terrarium) });
 *
 * What Terrarium doesn't own goes to the real network, as Mock Service Worker lets an unhandled request through, unless `unowned` is `"refuse"`.
 */

export interface OutboundOptions {
  /** What to do with a request for an address Terrarium doesn't own: send it to the network (the default), or refuse it with a 502. */
  readonly unowned?: Unowned;
}

/**
 * Jetstream for a Worker that opened a socket to it. One end of a pair goes back in the 101, for Miniflare to couple to the Worker's socket; the sandbox feeds the other. Jetstream is the only socket a Worker can open in the sandbox: anything else is hung up on with a reason, rather than left to look like a quiet stream.
 */
const socketTo = (terrarium: Terrarium, url: string): WorkerResponse => {
  const { 0: client, 1: server } = new WebSocketPair();
  const jetstream = terrarium.connect(url);
  let ended = false;
  let hungUp = false;
  const hangUp = (code?: number, reason?: string): void => {
    ended = true;

    if (!hungUp) {
      hungUp = true;
      server.close(code, reason);
    }
  };

  server.accept();
  jetstream.onmessage = ({ data }): void => {
    if (!ended) {
      server.send(data);
    }
  };
  jetstream.onerror = (): void => {
    hangUp(1011, `Only Jetstream takes a socket here: ${url}`);
  };
  jetstream.onclose = ({ code, reason }): void => {
    // A Worker can't be sent the codes that only say no code came.
    if (code === 1005 || code === 1006) {
      hangUp();
    } else {
      hangUp(code, reason);
    }
  };
  server.addEventListener("message", ({ data }) => {
    jetstream.send(typeof data === "string" ? data : "");
  });
  // The Worker hanging up: stop the subscription, and answer its close.
  server.addEventListener("close", () => {
    ended = true;
    jetstream.close();
  });

  return new WorkerResponse(null, { status: 101, webSocket: client });
};

export const outbound =
  (terrarium: Terrarium, { unowned = "network" }: OutboundOptions = {}) =>
  async (request: WorkerRequest): Promise<WorkerResponse> => {
    if (
      request.headers.get("upgrade")?.toLowerCase() === "websocket" &&
      terrarium.owns(request.url)
    ) {
      return socketTo(terrarium, request.url);
    }

    const standard = await fromWorker(request);

    if (terrarium.owns(standard.url)) {
      return responseToWorker(await terrarium.fetch(standard));
    }

    return responseToWorker(
      unowned === "refuse"
        ? new Response(refuse(standard.url), { status: 502 })
        : await fetch(standard)
    );
  };

/**
 * Put a Worker running under Miniflare inside the sandbox at a `.test` or `.internal` host (`.internal` for an OAuth client), so PDSes and pages there can reach it: an OAuth client's metadata, its callback. Returns how to take it away again.
 *
 *     mount(terrarium, "app.example.test", miniflare);
 */
export const mount = (
  terrarium: Terrarium,
  host: string,
  miniflare: Pick<Miniflare, "dispatchFetch">
): (() => void) =>
  terrarium.mount(host, async (request) =>
    responseFromWorker(await miniflare.dispatchFetch(await toWorker(request)))
  );
