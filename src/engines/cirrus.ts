import { createHmac, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { hash } from "bcryptjs";
import {
  Miniflare,
  type Response as WorkerResponse,
  type WebSocket as WorkerWebSocket
} from "miniflare";
import {
  fromWorker,
  responseFromWorker,
  responseToWorker,
  toWorker
} from "../bridge";
import { keyFrom } from "../keys";

/** Cirrus bundled into one module by `yarn build:engines`, with its Durable Objects. Found from the source (`src/engines/`) and from the built package (`dist/`) alike. */
const BUNDLE =
  ["../../engines/cirrus/dist/entry.js", "../engines/cirrus/dist/entry.js"]
    .map((path) => fileURLToPath(new URL(path, import.meta.url)))
    .find((path) => existsSync(path)) ?? "engines/cirrus/dist/entry.js";

/** One account on its own Cirrus, which is how Cirrus works: single-user, one deployment each. */
export interface CirrusAccount {
  readonly did: string;
  readonly handle: string;
  /** Where the PDS says it lives, as it appears in the account's DID document. */
  readonly hostname: string;
  readonly password: string;
  /** The account's secp256k1 signing key, hex-encoded, so a restart keeps the same identity. */
  readonly signingKey: string;
}

export interface CirrusOptions {
  readonly account: CirrusAccount;
  /** A directory to keep the repository and blobs in across restarts. In memory when left out. */
  readonly persist?: string;
  /** Every request Cirrus makes to anywhere: resolving a DID, fetching an OAuth client's metadata, asking a relay to crawl. Nothing reaches the network unless this sends it there. */
  readonly outbound: (request: Request) => Promise<Response>;
  /** Also answer on a socket, for clients outside this process. Left out, it's reachable only through `fetch`. */
  readonly listen?: { readonly host: string; readonly port: number };
}

export interface CirrusEngine {
  /** Send a request to the PDS, as if it arrived at its hostname. */
  fetch(request: Request): Promise<Response>;
  /** Open a WebSocket on the PDS (its firehose), accepted and ready to listen to. */
  upgrade(url: string): Promise<WorkerWebSocket>;
  /** The bearer token Cirrus accepts for writes outside OAuth, for seeding. */
  readonly authToken: string;
  /** Where Miniflare reaches its `workerd` process: Terrarium's own traffic, which an interceptor must let through. */
  readonly runtime: string;
  dispose(): Promise<void>;
}

/** The bearer token for seeding, which nothing outside this process holds, so it can change on every start. */
const secret = (): string => randomBytes(32).toString("base64url");

/** The secret Cirrus signs sessions and OAuth tokens with. Derived from the account's key rather than random, so a restart doesn't sign everyone out or void an app's grant. */
const jwtSecret = (signingKey: string): string =>
  createHmac("sha256", signingKey)
    .update("terrarium/cirrus/jwt-secret")
    .digest("base64");

/** Start one Cirrus PDS under Miniflare, on the real `workerd` runtime, for one account. */
export const startCirrus = async ({
  account,
  persist,
  outbound,
  listen
}: CirrusOptions): Promise<CirrusEngine> => {
  if (!existsSync(BUNDLE)) {
    throw new Error(
      `Cirrus isn't built yet: run \`yarn build:engines\` first (${BUNDLE} is missing).`
    );
  }

  const signingKey = await keyFrom(account.signingKey);
  const authToken = secret();
  const miniflare = new Miniflare({
    modules: true,
    scriptPath: BUNDLE,
    // Module names are relative to this; left to the default (the working directory), a bundle outside it gets a `../` name that workerd refuses.
    modulesRoot: dirname(BUNDLE),
    compatibilityDate: "2025-12-02",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: {
      ACCOUNT: { className: "AccountDurableObject", useSQLite: true },
      SPACES: { className: "SpaceDurableObject", useSQLite: true },
      SPACES_INDEX: { className: "SpaceIndexDurableObject", useSQLite: true }
    },
    r2Buckets: ["BLOBS"],
    bindings: {
      DID: account.did,
      HANDLE: account.handle,
      PDS_HOSTNAME: account.hostname,
      AUTH_TOKEN: authToken,
      SIGNING_KEY: account.signingKey,
      SIGNING_KEY_PUBLIC: (await signingKey.exportPublicKey("did")).slice(
        "did:key:".length
      ),
      JWT_SECRET: jwtSecret(account.signingKey),
      PASSWORD_HASH: await hash(account.password, 10)
    },
    ...(persist !== undefined && { defaultPersistRoot: persist }),
    ...(listen && { host: listen.host, port: listen.port }),
    outboundService: async (request): Promise<WorkerResponse> =>
      responseToWorker(await outbound(await fromWorker(request)))
  });

  const { origin: runtime } = await miniflare.ready;

  return {
    authToken,
    runtime,
    async fetch(request) {
      return responseFromWorker(
        await miniflare.dispatchFetch(await toWorker(request))
      );
    },
    async upgrade(url) {
      const response = await miniflare.dispatchFetch(url, {
        headers: { upgrade: "websocket" }
      });

      if (!response.webSocket) {
        throw new Error(
          `${url} answered ${String(response.status)}, not a WebSocket.`
        );
      }

      response.webSocket.accept();

      return response.webSocket;
    },
    async dispose() {
      await miniflare.dispose();
    }
  };
};
