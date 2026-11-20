import {
  CompositeDidDocumentResolver,
  DohJsonHandleResolver,
  PlcDidDocumentResolver,
  WellKnownHandleResolver
} from "@atcute/identity-resolver";
import { http, HttpResponse } from "msw/http";
import { setupServer } from "msw/node";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { handlers } from "../msw";
import { createTerrarium, type Account, type Terrarium } from "../terrarium";

/**
 * Terrarium is meant to be invisible to the code under test, as Mock Service Worker is: an app keeps resolving DIDs at `plc.directory`, reading the PDS its DID document names, signing in with a password, and following Bluesky's Jetstream, and every one of those requests is answered by the sandbox. Nothing here is configured to point at Terrarium: the resolvers are atcute's defaults, and the rest is plain `fetch` and `WebSocket`.
 */

const NOTE = "dev.terrarium.test.note";

/** Every message on a socket, parsed, and a way to wait for the next. */
const messages = (
  socket: WebSocket
): { next(): Promise<Record<string, unknown>> } => {
  const queue: Record<string, unknown>[] = [];
  const waiting: ((message: Record<string, unknown>) => void)[] = [];

  socket.addEventListener("message", (event: { data: unknown }) => {
    const message = JSON.parse(String(event.data)) as Record<string, unknown>;
    const waiter = waiting.shift();

    if (waiter) {
      waiter(message);
    } else {
      queue.push(message);
    }
  });

  return {
    next: async () =>
      new Promise((resolve) => {
        const queued = queue.shift();

        if (queued) {
          resolve(queued);
        } else {
          waiting.push(resolve);
        }
      })
  };
};

describe("terrarium behind Mock Service Worker", () => {
  let terrarium: Terrarium;
  let alice: Account;
  const server = setupServer();

  beforeAll(async () => {
    terrarium = await createTerrarium();
    alice = await terrarium.createAccount({ name: "alice" });
    server.use(
      ...handlers(terrarium),
      // An app's own mocks sit beside Terrarium's, for whatever isn't the Atmosphere.
      http.get("https://catalog.example.com/beers/one", () =>
        HttpResponse.json({ name: "One More" })
      )
    );
    server.listen({ onUnhandledFrame: "error" });
  }, 60_000);

  afterAll(async () => {
    server.close();
    await terrarium.dispose();
  });

  it("resolves an account's DID at plc.directory, as any resolver does", async () => {
    const document = await new CompositeDidDocumentResolver({
      methods: { plc: new PlcDidDocumentResolver() }
    }).resolve(alice.did as `did:plc:${string}`);

    expect(document.service?.[0]?.serviceEndpoint).toBe(
      "https://alice.terrarium.test"
    );
  });

  it("resolves its handle over DNS-over-HTTPS and from the handle's own host", async () => {
    await expect(
      new DohJsonHandleResolver({
        dohUrl: "https://cloudflare-dns.com/dns-query"
      }).resolve("alice.test")
    ).resolves.toBe(alice.did);
    await expect(
      new WellKnownHandleResolver().resolve("alice.test")
    ).resolves.toBe(alice.did);
  });

  it("signs in with the password and writes as the account, at the PDS its DID document names", async () => {
    const session = (await (
      await fetch(
        "https://alice.terrarium.test/xrpc/com.atproto.server.createSession",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            identifier: "alice.test",
            password: alice.password
          })
        }
      )
    ).json()) as { accessJwt: string; did: string };

    expect(session.did).toBe(alice.did);

    const created = await fetch(
      "https://alice.terrarium.test/xrpc/com.atproto.repo.createRecord",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${session.accessJwt}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          repo: alice.did,
          collection: NOTE,
          record: {
            $type: NOTE,
            text: "written through a session",
            createdAt: new Date().toISOString()
          }
        })
      }
    );

    expect(created.status).toBe(200);
  });

  it("delivers the account's writes on Bluesky's Jetstream address", async () => {
    const socket = new WebSocket(
      `wss://jetstream2.us-east.bsky.network/subscribe?wantedDids=${alice.did}&wantedCollections=${NOTE}`
    );
    const feed = messages(socket);

    await new Promise((resolve) => {
      socket.addEventListener("open", resolve);
    });
    await terrarium.seed("alice", [
      { collection: NOTE, record: { text: "on the stream" } }
    ]);

    // Earlier tests' writes may still be on their way: a live subscriber sees everything from when it connected.
    let event = await feed.next();

    while (
      (event["commit"] as { record?: { text?: string } } | undefined)?.record
        ?.text !== "on the stream"
    ) {
      event = await feed.next();
    }

    expect(event).toMatchObject({
      did: alice.did,
      kind: "commit",
      commit: { collection: NOTE, record: { text: "on the stream" } }
    });
    socket.close();
  });

  it("suggests the sandbox's accounts as someone types, from Bluesky's AppView address", async () => {
    await terrarium.seed("alice", [
      {
        collection: "app.bsky.actor.profile",
        rkey: "self",
        record: { displayName: "Alice Liddell" }
      }
    ]);

    const found = (await (
      await fetch(
        "https://public.api.bsky.app/xrpc/app.bsky.actor.searchActorsTypeahead?q=ali&limit=6"
      )
    ).json()) as { actors: unknown[] };

    expect(found.actors).toEqual([
      { did: alice.did, handle: "alice.test", displayName: "Alice Liddell" }
    ]);
  });

  it("leaves everything else to the app's own handlers", async () => {
    await expect(
      (await fetch("https://catalog.example.com/beers/one")).json()
    ).resolves.toEqual({ name: "One More" });
  });
});
