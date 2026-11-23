import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { mount, outbound } from "../miniflare";
import { createTerrarium, type Account, type Terrarium } from "../terrarium";

/**
 * Apps on Cloudflare Workers make their requests from `workerd`, out of reach of anything that patches Node's `fetch`. With `outbound` as its network, a Worker resolves identities and reads PDSes at their real addresses and gets the sandbox, exactly as code under Mock Service Worker does. Mounted, the same Worker is reachable from inside the sandbox, which is what an OAuth sign-in needs: the PDS fetches the app's client metadata and the browser comes back to its callback.
 */

const NOTE = "dev.terrarium.test.note";

/** A Worker that knows nothing about Terrarium: it reads a note the way any ATProto app would. */
const APP = `
export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/note") {
      const did = url.searchParams.get("did");
      const document = await (await fetch("https://plc.directory/" + did)).json();
      const pds = document.service[0].serviceEndpoint;
      const record = await (await fetch(pds + "/xrpc/com.atproto.repo.getRecord?repo=" + did + "&collection=${NOTE}&rkey=hello")).json();

      return Response.json({ pds, text: record.value.text });
    }

    // Catching up as a Durable Object's alarm would: open Jetstream from a cursor, read what's there, hang up.
    if (url.pathname === "/jetstream") {
      const did = url.searchParams.get("did");
      const response = await fetch("https://jetstream2.us-east.bsky.network/subscribe?cursor=0&wantedCollections=${NOTE}&wantedDids=" + did, { headers: { upgrade: "websocket" } });
      const socket = response.webSocket;

      if (!socket) {
        return new Response(null, { status: response.status });
      }

      socket.accept();

      const { commit } = await new Promise((resolve) => {
        socket.addEventListener("message", (event) => resolve(JSON.parse(event.data)));
      });

      socket.close();

      return Response.json({ rkey: commit.rkey, text: commit.record.text });
    }

    // The same on Jetstream's v2 stream: its first frame, or how it hung up.
    if (url.pathname === "/jetstream-v2") {
      const response = await fetch("https://jetstream2.us-east.bsky.network/xrpc/network.bsky.jetstream.subscribeEvents?kinds=commit&collections=${NOTE}&dids=" + url.searchParams.get("did") + "&cursor=" + url.searchParams.get("cursor"), { headers: { upgrade: "websocket" } });
      const socket = response.webSocket;

      socket.accept();

      const first = await new Promise((resolve) => {
        socket.addEventListener("message", (event) => resolve(JSON.parse(event.data)));
        socket.addEventListener("close", ({ code, reason }) => resolve({ code, reason }));
      });

      if (!("code" in first)) {
        socket.close();
      }

      return Response.json(first);
    }

    if (url.pathname === "/firehose") {
      const response = await fetch(url.searchParams.get("pds") + "/xrpc/com.atproto.sync.subscribeRepos", { headers: { upgrade: "websocket" } });
      const socket = response.webSocket;

      socket.accept();

      const { code, reason } = await new Promise((resolve) => {
        socket.addEventListener("close", resolve);
      });

      return Response.json({ code, reason });
    }

    if (url.pathname === "/elsewhere") {
      return new Response(null, { status: (await fetch("https://example.com/")).status });
    }

    return new Response("not found", { status: 404 });
  }
};
`;

describe("terrarium as a Worker's network", () => {
  let terrarium: Terrarium;
  let alice: Account;
  let app: Miniflare;

  beforeAll(async () => {
    terrarium = await createTerrarium();
    alice = await terrarium.createAccount({ name: "alice" });
    await terrarium.seed("alice", [
      { collection: NOTE, rkey: "hello", record: { text: "hello, worker" } }
    ]);
    app = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script: APP,
        compatibilityDate: "2025-12-02",
        outboundService: outbound(terrarium, { unowned: "refuse" })
      })
    );
    await app.ready;
  }, 60_000);

  afterAll(async () => {
    await app.dispose();
    await terrarium.dispose();
  });

  it("resolves and reads from inside workerd, at the addresses the network uses", async () => {
    const response = await app.dispatchFetch(
      `http://app/note?did=${alice.did}`
    );

    await expect(response.json()).resolves.toEqual({
      pds: "https://alice.terrarium.test",
      text: "hello, worker"
    });
  });

  // An AppView in a Durable Object can't hold Jetstream open without paying for every second of it, so it catches up on a schedule: the socket has to work from inside workerd, cursor and all.
  it("follows Jetstream from inside workerd, replaying from a cursor", async () => {
    const response = await app.dispatchFetch(
      `http://app/jetstream?did=${alice.did}`
    );

    await expect(response.json()).resolves.toEqual({
      rkey: "hello",
      text: "hello, worker"
    });
  });

  it("speaks Jetstream's v2 stream from inside workerd too, refusals and all", async () => {
    const replayed = await app.dispatchFetch(
      `http://app/jetstream-v2?did=${alice.did}&cursor=1`
    );
    const refused = await app.dispatchFetch(
      `http://app/jetstream-v2?did=${alice.did}&cursor=0`
    );

    await expect(replayed.json()).resolves.toMatchObject({
      $type: "message",
      payload: {
        $type: "network.bsky.jetstream.subscribeEvents#commit",
        rkey: "hello",
        record: { text: "hello, worker" }
      }
    });
    await expect(refused.json()).resolves.toEqual({
      code: 1008,
      reason: expect.stringContaining("CursorTooOld")
    });
  });

  // A socket that opened and never spoke would look like a quiet stream, and a test waiting on it would hang instead of failing.
  it("hangs up, saying why, on a socket it can't serve", async () => {
    const response = await app.dispatchFetch(
      `http://app/firehose?pds=${alice.endpoint}`
    );

    await expect(response.json()).resolves.toEqual({
      code: 1011,
      reason: expect.stringContaining("Jetstream")
    });
  });

  it("refuses what Terrarium doesn't own, when asked to keep the Worker off the network", async () => {
    const response = await app.dispatchFetch("http://app/elsewhere");

    expect(response.status).toBe(502);
  });

  it("is reachable from inside the sandbox once mounted, as a PDS or a redirect would reach it", async () => {
    const unmount = mount(terrarium, "app.example.test", app);
    const response = await terrarium.fetch(
      new Request(`https://app.example.test/note?did=${alice.did}`)
    );

    await expect(response.json()).resolves.toMatchObject({
      text: "hello, worker"
    });

    unmount();

    expect(
      (await terrarium.fetch(new Request("https://app.example.test/note")))
        .status
    ).toBe(502);
  });

  it("only mounts apps at .test hosts, which can't exist anywhere else", () => {
    expect(() =>
      terrarium.mount("app.example.com", async () => new Response())
    ).toThrow(/\.test/u);
  });
});
