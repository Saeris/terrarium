import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { deriveDidFromGenesisOp, signOperation } from "@atcute/did-plc";
import * as v from "valibot";
import { startCirrus, type CirrusEngine } from "./engines/cirrus";
import { createJetstream, filterFrom, type Jetstream } from "./jetstream";
import { keyFrom, newKey } from "./keys";
import { createPlc } from "./plc";

/**
 * The sandbox: a PLC directory, one Cirrus PDS per account, and a Jetstream fed by their firehoses, all routed by origin through one `fetch`, so nothing they do to each other leaves the process unless something is listening on a port.
 *
 * Accounts are made on demand (`createAccount`), each a real did:plc on its own PDS, and seeded with records (`seed`). With a directory, all of it survives a restart: same DIDs, same keys, same records. Jetstream's history doesn't: it starts empty, as a real one would for a client that's been away longer than its retention.
 */

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORTS = { plc: 2582, jetstream: 2584, pds: 2600 } as const;

/** The part of a WebSocket a client reads from, as browsers and Node have it. What `connect` gives in place of one. */
export interface SocketLike {
  onopen: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  close(): void;
}

/** Test accounts have a known password unless asked otherwise: this is a sandbox, and whatever drives it needs to sign in. */
export const DEFAULT_PASSWORD = "password";

const nameSchema = v.pipe(
  v.string(),
  v.regex(
    /^[a-z][a-z0-9-]{0,29}$/u,
    "An account name is lowercase letters, digits and dashes, starting with a letter."
  )
);

const storedAccountSchema = v.object({
  name: nameSchema,
  did: v.string(),
  handle: v.string(),
  /** The PDS's origin, as the DID document names it. */
  endpoint: v.string(),
  password: v.string(),
  /** The repo's signing key, hex: Cirrus's `SIGNING_KEY`. */
  signingKey: v.string(),
  /** The key that controls the DID at the PLC directory, hex. Terrarium holds it, so it can move an account or change its handle. */
  rotationKey: v.string()
});

const stateSchema = v.object({
  version: v.literal(1),
  accounts: v.array(storedAccountSchema)
});

type StoredAccount = v.InferOutput<typeof storedAccountSchema>;

/** An account as callers see it: everything needed to use it, nothing that controls it. */
export interface Account {
  readonly name: string;
  readonly did: string;
  readonly handle: string;
  /** The PDS's URL. */
  readonly endpoint: string;
  readonly password: string;
}

export interface TerrariumOptions {
  /** Where to keep accounts, the PLC log and each PDS's data. In memory when left out. */
  readonly dir?: string;
  /** The host every service is addressed by. */
  readonly host?: string;
  readonly ports?: {
    readonly plc: number;
    readonly jetstream: number;
    readonly pds: number;
  };
  /** Have each PDS answer on its own port, for clients outside this process. */
  readonly listen?: boolean;
}

export interface NewAccount {
  /** Short name for the account: `alice` makes `alice.test`. */
  readonly name: string;
  readonly handle?: string | undefined;
  readonly password?: string | undefined;
}

/** A record to put in an account's repo. `$type` defaults to the collection. */
export interface SeedRecord {
  readonly collection: string;
  readonly rkey?: string | undefined;
  readonly record: Readonly<Record<string, unknown>>;
}

export interface Seeded {
  readonly uri: string;
  readonly cid: string;
}

export interface Terrarium {
  /** The PLC directory's URL: give it to anything that resolves did:plc. */
  readonly plcUrl: string;
  /** Jetstream's subscribe URL: give it to anything that follows changes. */
  readonly jetstreamUrl: string;
  /** Jetstream itself, for subscribing in-process and for switching its faults on and off. */
  readonly jetstream: Jetstream;
  /** Any request to any service in the sandbox, routed by its origin. Anything else is refused, never sent to the network. */
  fetch(request: Request): Promise<Response>;
  /** A WebSocket to Jetstream without a socket, for clients that take a `connect` function. */
  connect(url: string): SocketLike;
  accounts(): readonly Account[];
  account(name: string): Account | undefined;
  createAccount(account: NewAccount): Promise<Account>;
  /** Write records to an account's repo, as the account. */
  seed(name: string, records: readonly SeedRecord[]): Promise<Seeded[]>;
  dispose(): Promise<void>;
}

/** The most writes one `applyWrites` takes. */
const BATCH = 200;

const publicView = ({
  name,
  did,
  handle,
  endpoint,
  password
}: StoredAccount): Account => ({ name, did, handle, endpoint, password });

const appliedSchema = v.object({
  results: v.array(v.object({ uri: v.string(), cid: v.string() }))
});

const listedSchema = v.object({
  cursor: v.optional(v.string()),
  records: v.array(v.object({ uri: v.string() }))
});

/** Which of these collections' records the account already has, as `collection/rkey`, so a seed knows what it replaces. */
const existingKeys = async (
  engine: CirrusEngine,
  account: StoredAccount,
  collections: ReadonlySet<string>
): Promise<Set<string>> => {
  const keys = new Set<string>();

  for (const collection of collections) {
    let cursor: string | undefined;

    do {
      const url = new URL(
        `${account.endpoint}/xrpc/com.atproto.repo.listRecords`
      );

      url.searchParams.set("repo", account.did);
      url.searchParams.set("collection", collection);
      url.searchParams.set("limit", "100");

      if (cursor !== undefined) {
        url.searchParams.set("cursor", cursor);
      }

      // oxlint-disable-next-line eslint/no-await-in-loop -- each page's cursor comes from the page before it.
      const page = v.parse(
        listedSchema,
        await (await engine.fetch(new Request(url))).json()
      );

      for (const { uri } of page.records) {
        keys.add(`${collection}/${uri.split("/").at(-1) ?? ""}`);
      }

      cursor = page.records.length > 0 ? page.cursor : undefined;
    } while (cursor !== undefined);
  }

  return keys;
};

export const createTerrarium = async ({
  dir,
  host = DEFAULT_HOST,
  ports = DEFAULT_PORTS,
  listen = false
}: TerrariumOptions = {}): Promise<Terrarium> => {
  const stateFile = dir && join(dir, "terrarium.json");

  if (dir) {
    await mkdir(dir, { recursive: true });
  }

  const plcUrl = `http://${host}:${String(ports.plc)}`;
  const plc = await createPlc(dir ? { file: join(dir, "plc.json") } : {});
  const stored: StoredAccount[] = stateFile
    ? v.parse(
        stateSchema,
        JSON.parse(
          await readFile(stateFile, "utf8").catch(
            () => '{"version":1,"accounts":[]}'
          )
        )
      ).accounts
    : [];
  const engines = new Map<string, CirrusEngine>();
  const jetstream = createJetstream();
  const jetstreamOrigin = `http://${host}:${String(ports.jetstream)}`;
  const jetstreamUrl = `ws://${host}:${String(ports.jetstream)}/subscribe`;
  let disposed = false;

  /** Feed a PDS's firehose to Jetstream, and pick it up again if it drops, for as long as the sandbox runs. */
  const follow = async (
    engine: CirrusEngine,
    endpoint: string
  ): Promise<void> => {
    const socket = await engine.upgrade(
      `${endpoint}/xrpc/com.atproto.sync.subscribeRepos`
    );

    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") {
        jetstream.ingest(new Uint8Array(event.data));
      }
    });
    socket.addEventListener("close", () => {
      if (!disposed && engines.get(new URL(endpoint).origin) === engine) {
        void follow(engine, endpoint);
      }
    });
  };

  const save = async (): Promise<void> => {
    if (!stateFile) {
      return;
    }

    await writeFile(
      `${stateFile}.tmp`,
      JSON.stringify({ version: 1, accounts: stored }, null, 2)
    );
    await rename(`${stateFile}.tmp`, stateFile);
  };

  const route = async (request: Request): Promise<Response> => {
    const { origin } = new URL(request.url);

    if (origin === plcUrl) {
      return plc.fetch(request);
    }

    if (origin === jetstreamOrigin) {
      return new Response("Jetstream speaks WebSocket: use `connect`.", {
        status: 426
      });
    }

    const engine = engines.get(origin);

    return engine
      ? engine.fetch(request)
      : new Response(`Terrarium has no service at ${origin}.`, {
          status: 502
        });
  };

  const start = async (account: StoredAccount): Promise<void> => {
    const endpoint = new URL(account.endpoint);
    const engine = await startCirrus({
      account: {
        did: account.did,
        handle: account.handle,
        hostname: endpoint.host,
        password: account.password,
        signingKey: account.signingKey
      },
      ...(dir && { persist: resolve(dir, "pds", account.name) }),
      outbound: route,
      ...(listen && {
        listen: { host: endpoint.hostname, port: Number(endpoint.port) }
      })
    });

    engines.set(endpoint.origin, engine);
    await follow(engine, endpoint.origin);
  };

  const connect = (url: string): SocketLike => {
    const target = new URL(url);
    let stop: (() => void) | undefined;
    const socket: SocketLike = {
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      close() {
        stop?.();
        stop = undefined;
        queueMicrotask(() => socket.onclose?.());
      }
    };

    // Opened on the next tick, as a real socket is, so a client can set its handlers first.
    queueMicrotask(() => {
      if (
        `http://${target.host}` !== jetstreamOrigin ||
        target.pathname !== "/subscribe"
      ) {
        socket.onerror?.();
        socket.onclose?.();

        return;
      }

      socket.onopen?.();
      // Each message in a later task, as the network delivers them: a replay mustn't arrive before the client has finished reacting to the open.
      stop = jetstream.subscribe(filterFrom(target), (event) => {
        const data = JSON.stringify(event);

        setTimeout(() => {
          socket.onmessage?.({ data });
        }, 0);
      });
    });

    return socket;
  };

  // One at a time: each is its own workerd.
  for (const account of stored) {
    await start(account);
  }

  return {
    plcUrl,
    jetstreamUrl,
    jetstream,
    fetch: route,
    connect,
    accounts: () => stored.map(publicView),
    account(name) {
      const found = stored.find((account) => account.name === name);

      return found && publicView(found);
    },
    async createAccount({ name, handle, password = DEFAULT_PASSWORD }) {
      v.parse(nameSchema, name);

      if (stored.some((account) => account.name === name)) {
        throw new Error(`There's already an account called ${name}.`);
      }

      const port = Math.max(
        ports.pds - 1,
        ...stored.map((account) => Number(new URL(account.endpoint).port))
      );
      const endpoint = `http://${host}:${String(port + 1)}`;
      const signingKey = await newKey();
      const rotationKey = await newKey();
      const genesis = await signOperation(
        {
          type: "plc_operation",
          prev: null,
          alsoKnownAs: [`at://${handle ?? `${name}.test`}`],
          rotationKeys: [
            await (await keyFrom(rotationKey)).exportPublicKey("did")
          ],
          verificationMethods: {
            atproto: await (await keyFrom(signingKey)).exportPublicKey("did")
          },
          services: {
            atproto_pds: { type: "AtprotoPersonalDataServer", endpoint }
          }
        },
        await keyFrom(rotationKey)
      );
      const did = await deriveDidFromGenesisOp(genesis);
      const registered = await plc.fetch(
        new Request(`${plcUrl}/${did}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(genesis)
        })
      );

      if (!registered.ok) {
        throw new Error(
          `The PLC directory refused ${did}: ${await registered.text()}`
        );
      }

      const account: StoredAccount = {
        name,
        did,
        handle: handle ?? `${name}.test`,
        endpoint,
        password,
        signingKey,
        rotationKey
      };

      await start(account);
      stored.push(account);
      await save();

      return publicView(account);
    },
    async seed(name, records) {
      const account = stored.find((candidate) => candidate.name === name);
      const engine = account && engines.get(new URL(account.endpoint).origin);

      if (!account || !engine) {
        throw new Error(`There's no account called ${name}.`);
      }

      const seeded: Seeded[] = [];
      const existing = await existingKeys(
        engine,
        account,
        new Set(
          records
            .filter(({ rkey }) => rkey !== undefined)
            .map(({ collection }) => collection)
        )
      );

      for (let at = 0; at < records.length; at += BATCH) {
        const response = await engine.fetch(
          new Request(`${account.endpoint}/xrpc/com.atproto.repo.applyWrites`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${engine.authToken}`,
              "content-type": "application/json"
            },
            body: JSON.stringify({
              repo: account.did,
              writes: records
                .slice(at, at + BATCH)
                .map(({ collection, rkey, record }) => ({
                  // A record that's already there is replaced, so a fixture can be applied again, or changed and re-applied.
                  $type:
                    rkey !== undefined && existing.has(`${collection}/${rkey}`)
                      ? "com.atproto.repo.applyWrites#update"
                      : "com.atproto.repo.applyWrites#create",
                  collection,
                  ...(rkey !== undefined && { rkey }),
                  value: { $type: collection, ...record }
                }))
            })
          })
        );

        if (!response.ok) {
          throw new Error(
            `${account.handle}'s PDS refused the seed: ${await response.text()}`
          );
        }

        seeded.push(...v.parse(appliedSchema, await response.json()).results);
      }

      return seeded;
    },
    async dispose() {
      disposed = true;
      await Promise.all(
        [...engines.values()].map(async (engine) => engine.dispose())
      );
      engines.clear();
    }
  };
};
