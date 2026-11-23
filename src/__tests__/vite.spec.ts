import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { loadConfig, provision, type TerrariumConfig } from "../config";
import { isRunning, startServer, type Server } from "../server";
import type { Account } from "../terrarium";
import { terrarium } from "../vite";

/**
 * The Vite plugin is where an app says what sandbox it needs. `vite dev` must bring it up with the accounts and records named, reachable from the dev server's own process at the network's addresses, as the app's server code will look for them. The records are written every time, so the config stays what's there. A restart (an edited config) must not take the sandbox down under the new server, a sandbox someone else started must outlive the dev server, and Vitest's own server is left alone, since tests make their own sandboxes. The CLI reads the same options from the config file.
 */

const NOTE = "dev.terrarium.test.note";

interface Listed {
  records: { value: { text: string } }[];
}

/** What an app's server code finds: the DID's document at plc.directory, then the notes on the PDS it names. */
const notesOf = async (did: string): Promise<string[]> => {
  const document = (await (
    await fetch(`https://plc.directory/${did}`)
  ).json()) as { service: { serviceEndpoint: string }[] };
  const pds = document.service[0]?.serviceEndpoint ?? "";
  const listed = (await (
    await fetch(
      `${pds}/xrpc/com.atproto.repo.listRecords?repo=${did}&collection=${NOTE}`
    )
  ).json()) as Listed;

  return listed.records.map(({ value }) => value.text);
};

const accountAt = async (url: string, name: string): Promise<Account> =>
  (await (await fetch(`${url}/accounts/${name}`)).json()) as Account;

/** A dev server, as `vite dev` makes one: outside Vitest, which this file runs in. */
const develop = async (
  root: string,
  options: TerrariumConfig
): Promise<ViteDevServer> => {
  vi.stubEnv("VITEST", undefined);

  try {
    return await createServer({
      configFile: false,
      root,
      logLevel: "silent",
      server: { middlewareMode: true },
      plugins: [terrarium(options)]
    });
  } finally {
    vi.unstubAllEnvs();
  }
};

describe("the Vite plugin", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "terrarium-vite-"));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe("in vite dev", () => {
    const url = "http://127.0.0.1:27000";
    let server: ViteDevServer;

    beforeAll(async () => {
      server = await develop(root, {
        dir: "state",
        port: 27_000,
        ports: { plc: 27_010, jetstream: 27_020, pds: 27_100 },
        accounts: {
          venue: {
            handle: "venue.example.com",
            records: (venue) => [
              {
                collection: NOTE,
                rkey: "menu",
                record: { text: `at ${venue.did}` }
              }
            ]
          }
        }
      });
    }, 60_000);

    afterAll(async () => {
      await server.close();
    });

    it("brings the sandbox up with the config's accounts and records, at the addresses the dev server's code looks them up by", async () => {
      const venue = await accountAt(url, "venue");

      await expect(
        (
          await fetch("https://venue.example.com/.well-known/atproto-did")
        ).text()
      ).resolves.toBe(venue.did);
      await expect(notesOf(venue.did)).resolves.toEqual([`at ${venue.did}`]);
    });

    it("keeps the sandbox through a restart, and writes the config's records again", async () => {
      const venue = await accountAt(url, "venue");

      // The app changed the record while it ran.
      await fetch(`${url}/accounts/venue/records`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify([
          { collection: NOTE, rkey: "menu", record: { text: "changed" } }
        ])
      });
      vi.stubEnv("VITEST", undefined);

      try {
        await server.restart();
      } finally {
        vi.unstubAllEnvs();
      }

      await expect(isRunning(url)).resolves.toBe(true);
      await expect(notesOf(venue.did)).resolves.toEqual([`at ${venue.did}`]);
    }, 60_000);

    it("stops the sandbox it started when the dev server closes", async () => {
      await server.close();

      await expect(isRunning(url)).resolves.toBe(false);
    }, 30_000);
  });

  describe("with a sandbox already running", () => {
    let running: Server;

    beforeAll(async () => {
      running = await startServer({
        port: 27_200,
        ports: { plc: 27_210, jetstream: 27_220, pds: 27_300 }
      });
    }, 60_000);

    afterAll(async () => {
      await running.close();
    });

    it("gives it the config's accounts, and leaves it running for whatever else uses it", async () => {
      const server = await develop(root, {
        port: 27_200,
        accounts: { alice: {} }
      });

      await server.close();

      expect(running.terrarium.account("alice")?.handle).toBe("alice.test");
      await expect(isRunning(running.url)).resolves.toBe(true);
    }, 60_000);
  });

  it("leaves Vitest's own server alone", async () => {
    const server = await createServer({
      configFile: false,
      root,
      logLevel: "silent",
      server: { middlewareMode: true },
      plugins: [
        terrarium({
          port: 27_400,
          ports: { plc: 27_410, jetstream: 27_420, pds: 27_450 }
        })
      ]
    });

    try {
      await expect(isRunning("http://127.0.0.1:27400")).resolves.toBe(false);
    } finally {
      await server.close();
    }
  }, 60_000);
});

describe("the config's accounts", () => {
  let server: Server;

  beforeAll(async () => {
    server = await startServer({
      port: 27_500,
      ports: { plc: 27_510, jetstream: 27_520, pds: 27_600 }
    });
  }, 60_000);

  afterAll(async () => {
    await server.close();
  });

  const notes = async (): Promise<string[]> => {
    const alice = server.terrarium.account("alice");
    const response = await server.terrarium.fetch(
      new Request(
        `${alice?.endpoint ?? ""}/xrpc/com.atproto.repo.listRecords?repo=${alice?.did ?? ""}&collection=${NOTE}`
      )
    );

    return ((await response.json()) as Listed).records.map(
      ({ value }) => value.text
    );
  };

  it("replace what's there by rkey, so applying the config again changes what changed and adds nothing", async () => {
    await provision(server.url, {
      alice: {
        records: [{ collection: NOTE, rkey: "a", record: { text: "first" } }]
      }
    });
    await provision(server.url, {
      alice: {
        records: [{ collection: NOTE, rkey: "a", record: { text: "edited" } }]
      }
    });

    await expect(notes()).resolves.toEqual(["edited"]);
  });

  it("refuse a record without an rkey, which would be added again every time", async () => {
    await expect(
      provision(server.url, {
        alice: { records: [{ collection: NOTE, record: { text: "again" } }] }
      })
    ).rejects.toThrow(`alice's ${NOTE} record has no rkey.`);
  });
});

describe("reading a Vite config", () => {
  const fixtures = join(import.meta.dirname, "fixtures");

  it("finds the plugin's options, however it's nested, with its directory relative to the config", async () => {
    await expect(loadConfig(join(fixtures, "vite.config.ts"))).resolves.toEqual(
      {
        dir: join(fixtures, "state"),
        port: 2680,
        accounts: { alice: {}, venue: { handle: "venue.example.com" } }
      }
    );
  });

  it("is nothing where there's no Vite config", async () => {
    const empty = await mkdtemp(join(tmpdir(), "terrarium-no-config-"));

    try {
      await expect(loadConfig(undefined, empty)).resolves.toBeUndefined();
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});
