import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { deriveDidFromGenesisOp, signOperation } from "@atcute/did-plc";
import * as v from "valibot";
import { startCirrus, type CirrusEngine } from "./engines/cirrus";
import {
  APPVIEW_HOSTS,
  dohAnswer,
  dohHandle,
  isSandboxHost,
  JETSTREAM_HOSTS,
  JETSTREAM_URL,
  PDS_DOMAIN,
  PLC_HOST
} from "./hosts";
import { appview, type Profile } from "./appview";
import { createJetstream, filterFrom, type Jetstream } from "./jetstream";
import { keyFrom, newKey } from "./keys";
import { createPlc } from "./plc";

/**
 * The sandbox: a PLC directory, one Cirrus PDS per account, and a Jetstream fed by their firehoses, answering at the addresses the network uses. `plc.directory` is its PLC directory, Bluesky's Jetstream hosts are its Jetstream, and each account's DID document names its PDS at `https://<name>.terrarium.test`. A client under test keeps its real configuration; an interceptor (`./msw`, `./playwright`, or Miniflare's outbound service) hands `fetch` whatever `owns` says is Terrarium's.
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
  /** The port the PDS also answers on when the sandbox runs as a server. */
  port: v.number(),
  password: v.string(),
  /** The repo's signing key, hex: Cirrus's `SIGNING_KEY`. */
  signingKey: v.string(),
  /** The key that controls the DID at the PLC directory, hex. Terrarium holds it, so it can move an account or change its handle. */
  rotationKey: v.string()
});

/** The state file's version: identities made by an earlier one name other addresses, so they're started afresh rather than migrated. */
const VERSION = 2;

const stateSchema = v.object({
  version: v.literal(VERSION),
  accounts: v.array(storedAccountSchema)
});

type StoredAccount = v.InferOutput<typeof storedAccountSchema>;

/** An account as callers see it: everything needed to use it, nothing that controls it. */
export interface Account {
  readonly name: string;
  readonly did: string;
  readonly handle: string;
  /** The PDS's URL, as its DID document names it. */
  readonly endpoint: string;
  /** The same PDS on a local port, when the sandbox runs as a server: for clients nothing intercepts, such as `curl`. */
  readonly local?: string;
  readonly password: string;
}

export interface TerrariumOptions {
  /** Where to keep accounts, the PLC log and each PDS's data. In memory when left out. */
  readonly dir?: string;
  /** The host the local ports are on, when listening. */
  readonly host?: string;
  readonly ports?: {
    readonly plc: number;
    readonly jetstream: number;
    readonly pds: number;
  };
  /** Have each PDS answer on its own port too, for clients outside this process that nothing intercepts. */
  readonly listen?: boolean;
}

export interface NewAccount {
  /** Short name for the account: `alice` makes `alice.test`, on `https://alice.terrarium.test`. */
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
  /** The PLC directory: `https://plc.directory`, as clients already have it. */
  readonly plcUrl: string;
  /** Where to subscribe to Jetstream: one of Bluesky's own addresses, as clients already have it. */
  readonly jetstreamUrl: string;
  /** The local ports, when listening: for clients nothing intercepts. */
  readonly local?: { readonly plc: string; readonly jetstream: string };
  /** Jetstream itself, for subscribing in-process and for switching its faults on and off. */
  readonly jetstream: Jetstream;
  /** Whether a request to this URL is Terrarium's to answer. What an interceptor asks before handing a request over. */
  owns(url: string | URL): boolean;
  /** Whether a request is Terrarium's own traffic, to the `workerd` processes behind its PDSes, which an interceptor in the same process must let through untouched. */
  internal(url: string | URL): boolean;
  /**
   * Put an app inside the sandbox at a `.test` or `.internal` host (`.internal` for an OAuth client, which atproto's OAuth libraries refuse to be at `.test`), so everything else there can reach it: a PDS fetching its OAuth client metadata or a page following a redirect back to it. Returns how to take it away again.
   *
   *     terrarium.mount("app.example.test", (request) => miniflare.dispatchFetch(request));
   */
  mount(
    host: string,
    handler: (request: Request) => Promise<Response>
  ): () => void;
  /** Any request to any service in the sandbox, routed by its host. Anything else is refused, never sent to the network. */
  fetch(request: Request): Promise<Response>;
  /** A WebSocket to Jetstream without a socket, for clients that take a `connect` function. */
  connect(url: string): SocketLike;
  accounts(): readonly Account[];
  account(name: string): Account | undefined;
  createAccount(account: NewAccount): Promise<Account>;
  /** Write records to an account's repo, as the account. A record whose `rkey` is already there is replaced. */
  seed(name: string, records: readonly SeedRecord[]): Promise<Seeded[]>;
  dispose(): Promise<void>;
}

/** The most writes one `applyWrites` takes. */
const BATCH = 200;

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

const readState = async (file: string): Promise<StoredAccount[]> => {
  const text = await readFile(file, "utf8").catch(() => undefined);

  if (text === undefined) {
    return [];
  }

  const state: unknown = JSON.parse(text);
  const parsed = v.safeParse(stateSchema, state);

  if (!parsed.success) {
    throw new Error(
      `${file} was made by an older Terrarium, whose accounts name other addresses. Delete its directory and start again.`
    );
  }

  return parsed.output.accounts;
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

  const plc = await createPlc(dir ? { file: join(dir, "plc.json") } : {});
  const stored: StoredAccount[] = stateFile ? await readState(stateFile) : [];
  /** Each account's PDS, by the host its DID document names. */
  const engines = new Map<string, CirrusEngine>();
  /** Apps put inside the sandbox, by host. */
  const mounted = new Map<string, (request: Request) => Promise<Response>>();
  const jetstream = createJetstream();
  const local = listen
    ? {
        plc: `http://${host}:${String(ports.plc)}`,
        jetstream: `ws://${host}:${String(ports.jetstream)}/subscribe`
      }
    : undefined;
  let disposed = false;

  const localOf = (account: StoredAccount): string | undefined =>
    listen ? `http://${host}:${String(account.port)}` : undefined;

  const publicView = (account: StoredAccount): Account => {
    const alias = localOf(account);

    return {
      name: account.name,
      did: account.did,
      handle: account.handle,
      endpoint: account.endpoint,
      ...(alias !== undefined && { local: alias }),
      password: account.password
    };
  };

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
      if (!disposed && engines.get(new URL(endpoint).host) === engine) {
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
      JSON.stringify({ version: VERSION, accounts: stored }, null, 2)
    );
    await rename(`${stateFile}.tmp`, stateFile);
  };

  const byHandle = (handle: string): StoredAccount | undefined =>
    stored.find((account) => account.handle === handle);

  const isJetstream = (url: URL): boolean =>
    JETSTREAM_HOSTS.has(url.hostname) ||
    (local !== undefined && url.host === new URL(local.jetstream).host);

  const owns = (target: string | URL): boolean => {
    const url = new URL(target);
    const doh = dohHandle(url);

    return (
      url.hostname === PLC_HOST ||
      isJetstream(url) ||
      APPVIEW_HOSTS.has(url.hostname) ||
      isSandboxHost(url.hostname) ||
      (doh !== undefined && byHandle(doh) !== undefined)
    );
  };

  /** An account's `app.bsky.actor.profile`, for the AppView to show. */
  const profileOf = async (
    account: StoredAccount
  ): Promise<Profile | undefined> => {
    const engine = engines.get(new URL(account.endpoint).host);
    const response = await engine?.fetch(
      new Request(
        `${account.endpoint}/xrpc/com.atproto.repo.getRecord?repo=${account.did}&collection=app.bsky.actor.profile&rkey=self`
      )
    );
    const parsed = v.safeParse(
      v.object({
        value: v.object({
          displayName: v.optional(v.string()),
          description: v.optional(v.string())
        })
      }),
      response?.ok ? await response.json() : undefined
    );

    return parsed.success ? parsed.output.value : undefined;
  };

  const bluesky = appview(() =>
    stored.map((account) => ({
      did: account.did,
      handle: account.handle,
      profile: async (): Promise<Profile | undefined> => profileOf(account)
    }))
  );

  const route = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    if (
      url.hostname === PLC_HOST ||
      (local !== undefined && url.origin === local.plc)
    ) {
      return plc.fetch(request);
    }

    if (isJetstream(url)) {
      return new Response("Jetstream speaks WebSocket.", { status: 426 });
    }

    if (APPVIEW_HOSTS.has(url.hostname)) {
      return bluesky(request);
    }

    const engine = engines.get(url.host);

    if (engine) {
      return engine.fetch(request);
    }

    const app = mounted.get(url.host);

    if (app) {
      return app(request);
    }

    const handled = byHandle(url.hostname);

    if (handled && url.pathname === "/.well-known/atproto-did") {
      return new Response(handled.did, {
        headers: { "content-type": "text/plain" }
      });
    }

    const doh = dohHandle(url);

    if (doh !== undefined) {
      return dohAnswer(doh, byHandle(doh)?.did);
    }

    return new Response(`Terrarium has no service at ${url.origin}.`, {
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
      ...(listen && { listen: { host, port: account.port } })
    });

    engines.set(endpoint.host, engine);
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
      if (!isJetstream(target) || target.pathname !== "/subscribe") {
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
    plcUrl: `https://${PLC_HOST}`,
    jetstreamUrl: JETSTREAM_URL,
    ...(local && { local }),
    jetstream,
    owns,
    internal: (url) =>
      [...engines.values()].some(
        (engine) => new URL(url).origin === engine.runtime
      ),
    mount(appHost, handler) {
      if (!isSandboxHost(appHost)) {
        throw new Error(
          `Apps mount at .test or .internal hosts, which can't exist outside the sandbox: ${appHost} could.`
        );
      }

      mounted.set(appHost, handler);

      return () => {
        if (mounted.get(appHost) === handler) {
          mounted.delete(appHost);
        }
      };
    },
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

      const port =
        Math.max(ports.pds - 1, ...stored.map((account) => account.port)) + 1;
      const endpoint = `https://${name}.${PDS_DOMAIN}`;
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
        new Request(`https://${PLC_HOST}/${did}`, {
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
        port,
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
      const engine = account && engines.get(new URL(account.endpoint).host);

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
