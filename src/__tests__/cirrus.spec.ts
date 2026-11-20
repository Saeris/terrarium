import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import {
  startCirrus,
  type CirrusAccount,
  type CirrusEngine
} from "../engines/cirrus";
import { newKey } from "../keys";

/**
 * Cirrus is the PDS businesses run on in production, so Terrarium runs the same code rather than an imitation. These check the three things everything else builds on: it answers XRPC, it streams its firehose, and an account survives a restart with the same identity.
 */

const ORIGIN = "https://pds.alice.test";
const NOTE = "dev.terrarium.test.note";

const xrpc = (method: string, init?: RequestInit): Request =>
  new Request(`${ORIGIN}/xrpc/${method}`, init);

describe("cirrus inside Terrarium", () => {
  let account: CirrusAccount;
  let persist: string;
  let pds: CirrusEngine;
  const outbound: string[] = [];

  const start = async (): Promise<CirrusEngine> =>
    startCirrus({
      account,
      persist,
      outbound: async (request) => {
        outbound.push(request.url);

        return new Response("Terrarium has no route to this host.", {
          status: 502
        });
      }
    });

  const write = async (text: string): Promise<{ uri: string }> => {
    const response = await pds.fetch(
      xrpc("com.atproto.repo.createRecord", {
        method: "POST",
        headers: {
          authorization: `Bearer ${pds.authToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          repo: account.did,
          collection: NOTE,
          record: { $type: NOTE, text, createdAt: new Date().toISOString() }
        })
      })
    );

    expect(response.status).toBe(200);

    return (await response.json()) as { uri: string };
  };

  beforeAll(async () => {
    persist = await mkdtemp(join(tmpdir(), "terrarium-cirrus-"));
    account = {
      did: "did:web:pds.alice.test",
      handle: "alice.test",
      hostname: "pds.alice.test",
      password: "correct horse battery staple",
      signingKey: await newKey()
    };
    pds = await start();
  }, 60_000);

  afterAll(async () => {
    // What Cirrus tried to reach, all of it caught by the outbound handler: worth reading while the box is young.
    console.info("Cirrus outbound requests:", outbound);
    await pds.dispose();
    await rm(persist, { recursive: true, force: true });
  });

  it("writes and reads records over XRPC, as the account", async () => {
    const { uri } = await write("hello from the terrarium");
    const rkey = uri.split("/").at(-1) ?? "";
    const response = await pds.fetch(
      xrpc(
        `com.atproto.repo.getRecord?repo=${account.did}&collection=${NOTE}&rkey=${rkey}`
      )
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      uri,
      value: { text: "hello from the terrarium" }
    });
  });

  it("streams a write on its firehose, which is what a change feed is built from", async () => {
    const socket = await pds.upgrade(
      `${ORIGIN}/xrpc/com.atproto.sync.subscribeRepos`
    );

    const commit = new Promise<string>((resolve) => {
      socket.addEventListener("message", (event) => {
        const frame =
          typeof event.data === "string"
            ? event.data
            : new TextDecoder("latin1").decode(event.data);

        if (
          frame.includes("#commit") &&
          frame.includes("seen on the firehose")
        ) {
          resolve(frame);
        }
      });
    });

    await write("seen on the firehose");

    await expect(commit).resolves.toContain(NOTE);
    socket.close();
  });

  it("keeps the account and its records across a restart", async () => {
    const { uri } = await write("still here after a restart");

    await pds.dispose();
    pds = await start();

    const described = await pds.fetch(
      xrpc(`com.atproto.repo.describeRepo?repo=${account.did}`)
    );
    const rkey = uri.split("/").at(-1) ?? "";
    const record = await pds.fetch(
      xrpc(
        `com.atproto.repo.getRecord?repo=${account.did}&collection=${NOTE}&rkey=${rkey}`
      )
    );

    await expect(described.json()).resolves.toMatchObject({
      did: account.did,
      handle: account.handle
    });
    expect(record.status).toBe(200);
  }, 60_000);
});
