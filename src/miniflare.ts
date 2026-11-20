import type {
  Miniflare,
  Request as WorkerRequest,
  Response as WorkerResponse
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

export const outbound =
  (terrarium: Terrarium, { unowned = "network" }: OutboundOptions = {}) =>
  async (request: WorkerRequest): Promise<WorkerResponse> => {
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
