import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createTerrarium, type Account, type Terrarium } from "../terrarium";

/**
 * What an agent or a test needs from the sandbox: make an account when it wants one, fill it with records, and find it all again after a restart. Each account has to be a real identity, resolvable the way any client resolves one, or tests against it prove nothing about the network.
 */

const NOTE = "dev.terrarium.test.note";

describe("the sandbox", () => {
  let dir: string;
  let terrarium: Terrarium;
  let alice: Account;

  const get = async (url: string): Promise<Response> =>
    terrarium.fetch(new Request(url));

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "terrarium-"));
    terrarium = await createTerrarium({ dir });
    alice = await terrarium.createAccount({ name: "alice" });
  }, 60_000);

  afterAll(async () => {
    await terrarium.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  it("makes an account that resolves like any other: its did:plc names its handle and its own PDS", async () => {
    const document = await (
      await get(`${terrarium.plcUrl}/${alice.did}`)
    ).json();

    expect(alice.did).toMatch(/^did:plc:/u);
    expect(document).toMatchObject({
      alsoKnownAs: ["at://alice.test"],
      service: [{ serviceEndpoint: alice.endpoint }]
    });

    const described = await get(
      `${alice.endpoint}/xrpc/com.atproto.repo.describeRepo?repo=${alice.did}`
    );

    await expect(described.json()).resolves.toMatchObject({
      did: alice.did,
      handle: "alice.test"
    });
  });

  it("gives each account its own PDS, as Cirrus is single-user", async () => {
    const bob = await terrarium.createAccount({ name: "bob" });

    expect(bob.endpoint).not.toBe(alice.endpoint);
    expect(terrarium.accounts().map(({ name }) => name)).toEqual([
      "alice",
      "bob"
    ]);
  }, 60_000);

  it("seeds records that anyone can read back, more than one batch's worth", async () => {
    const records = Array.from({ length: 205 }, (_, index) => ({
      collection: NOTE,
      rkey: `note-${String(index).padStart(3, "0")}`,
      record: { text: `note ${String(index)}` }
    }));

    await expect(terrarium.seed("alice", records)).resolves.toHaveLength(205);

    const read = await get(
      `${alice.endpoint}/xrpc/com.atproto.repo.getRecord?repo=${alice.did}&collection=${NOTE}&rkey=note-204`
    );

    await expect(read.json()).resolves.toMatchObject({
      value: { $type: NOTE, text: "note 204" }
    });
  }, 60_000);

  it("replaces records a seed names again, so a fixture can be changed and re-applied", async () => {
    await terrarium.seed("alice", [
      { collection: NOTE, rkey: "note-000", record: { text: "changed" } },
      { collection: NOTE, rkey: "brand-new", record: { text: "added" } }
    ]);

    const read = async (rkey: string): Promise<unknown> =>
      (
        await get(
          `${alice.endpoint}/xrpc/com.atproto.repo.getRecord?repo=${alice.did}&collection=${NOTE}&rkey=${rkey}`
        )
      ).json();

    await expect(read("note-000")).resolves.toMatchObject({
      value: { text: "changed" }
    });
    await expect(read("brand-new")).resolves.toMatchObject({
      value: { text: "added" }
    });
  }, 60_000);

  it("refuses to reach anything outside it", async () => {
    expect((await get("https://bsky.social/xrpc/_health")).status).toBe(502);
  });

  it("won't make two accounts with one name", async () => {
    await expect(terrarium.createAccount({ name: "alice" })).rejects.toThrow(
      /already/u
    );
  });

  it("comes back after a restart with the same identities and records", async () => {
    await terrarium.dispose();
    terrarium = await createTerrarium({ dir });

    expect(terrarium.account("alice")).toEqual(alice);

    const read = await get(
      `${alice.endpoint}/xrpc/com.atproto.repo.getRecord?repo=${alice.did}&collection=${NOTE}&rkey=note-000`
    );
    const resolved = await get(`${terrarium.plcUrl}/${alice.did}`);

    expect(read.status).toBe(200);
    expect(resolved.status).toBe(200);
  }, 60_000);
});
