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
