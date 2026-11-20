import * as CBOR from "@atcute/cbor";
import { fromUint8Array } from "@atcute/car";
import * as CID from "@atcute/cid";
import { isCidLink, type CidLink } from "@atcute/cid";
import * as v from "valibot";

/**
 * Jetstream: every PDS's firehose turned into JSON events, filtered by DID and collection, with a microsecond cursor to resume from. The same events and query parameters as Bluesky's Jetstream, so a client written against it works here unchanged.
 *
 * There's no relay in between: each PDS's `subscribeRepos` feeds it directly. What a relay can do to a client (fall behind, or stop carrying an account altogether) is something to switch on (`pause`, `ignore`), not something that happens by accident.
 */

export interface CommitEvent {
  readonly did: string;
  readonly time_us: number;
  readonly kind: "commit";
  readonly commit: {
    readonly rev: string;
    readonly operation: "create" | "update" | "delete";
    readonly collection: string;
    readonly rkey: string;
    readonly record?: unknown;
    readonly cid?: string;
  };
}

export interface IdentityEvent {
  readonly did: string;
  readonly time_us: number;
  readonly kind: "identity";
  readonly identity: {
    readonly did: string;
    readonly handle?: string | undefined;
    readonly seq: number;
    readonly time: string;
  };
}

export interface AccountEvent {
  readonly did: string;
  readonly time_us: number;
  readonly kind: "account";
  readonly account: {
    readonly did: string;
    readonly active: boolean;
    readonly status?: string | undefined;
    readonly seq: number;
    readonly time: string;
  };
}

export type JetstreamEvent = CommitEvent | IdentityEvent | AccountEvent;

/** What a subscriber asked for, as Jetstream's query string says it. */
export interface Filter {
  /** Only these accounts. Every account when empty. */
  readonly wantedDids: readonly string[];
  /** Only these collections, or NSID prefixes ending in `.*`. Every collection when empty; identity and account events always pass. */
  readonly wantedCollections: readonly string[];
  /** Replay from this `time_us`, then carry on live. Live only when left out. */
  readonly cursor?: number | undefined;
}

export interface Jetstream {
  /** One `subscribeRepos` frame from a PDS. */
  ingest(frame: Uint8Array): void;
  /** Events matching the filter: the replay first, then as they happen. Returns how to stop. */
  subscribe(
    filter: Filter,
    listener: (event: JetstreamEvent) => void
  ): () => void;
  /** Hold every event back from subscribers, as a relay that's fallen behind does. They're kept, and delivered on `resume`. */
  pause(): void;
  resume(): void;
  /** Stop carrying an account's events at all, as the relay did with `venue-pds.taproom.social` on 2026-10-25. Nothing it does is recorded until `heed`. */
  ignore(did: string): void;
  heed(did: string): void;
  readonly state: {
    readonly paused: boolean;
    readonly ignored: readonly string[];
  };
}

/** How many events to keep for replaying from a cursor. */
const RETAIN = 10_000;

/** Jetstream's query string, as a filter. */
export const filterFrom = (url: URL): Filter => {
  const cursor = url.searchParams.get("cursor");

  return {
    wantedDids: url.searchParams.getAll("wantedDids"),
    wantedCollections: url.searchParams.getAll("wantedCollections"),
    ...(cursor !== null && { cursor: Number(cursor) })
  };
};

const matches = (filter: Filter, event: JetstreamEvent): boolean =>
  (filter.wantedDids.length === 0 || filter.wantedDids.includes(event.did)) &&
  (event.kind !== "commit" ||
    filter.wantedCollections.length === 0 ||
    filter.wantedCollections.some((wanted) =>
      wanted.endsWith(".*")
        ? event.commit.collection.startsWith(wanted.slice(0, -1))
        : event.commit.collection === wanted
    ));

/** The frame types a PDS's firehose sends that Jetstream passes on, checked rather than trusted. */
const headerSchema = v.object({ t: v.optional(v.string()) });

const commitSchema = v.object({
  repo: v.string(),
  rev: v.string(),
  blocks: v.custom<CBOR.Bytes>(CBOR.isBytes),
  ops: v.array(
    v.object({
      action: v.picklist(["create", "update", "delete"]),
      path: v.string(),
      cid: v.nullish(v.custom<CidLink>(isCidLink))
    })
  )
});

const identitySchema = v.object({
  did: v.string(),
  handle: v.optional(v.string()),
  seq: v.number(),
  time: v.string()
});

const accountSchema = v.object({
  did: v.string(),
  active: v.boolean(),
  status: v.optional(v.string()),
  seq: v.number(),
  time: v.string()
});

/** A firehose frame: a header naming its type, then its body. */
const frameOf = (
  bytes: Uint8Array
):
  | { readonly type: string | undefined; readonly body: unknown }
  | undefined => {
  try {
    const [header, rest]: [unknown, Uint8Array] = CBOR.decodeFirst(bytes);
    const parsed = v.safeParse(headerSchema, header);

    return parsed.success
      ? { type: parsed.output.t, body: CBOR.decode(rest) }
      : undefined;
  } catch {
    return undefined;
  }
};

/** A CBOR value as JSON: links as `{ $link }`, bytes as `{ $bytes }`, which is how Jetstream writes records. */
const asJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

export const createJetstream = (): Jetstream => {
  const events: JetstreamEvent[] = [];
  const subscribers = new Set<{
    filter: Filter;
    listener: (event: JetstreamEvent) => void;
  }>();
  const ignored = new Set<string>();
  let paused = false;
  let held: JetstreamEvent[] = [];
  let last = 0;

  /** Microseconds since the epoch, never repeating and never going back: it's every subscriber's cursor. */
  const now = (): number => {
    last = Math.max(Date.now() * 1000, last + 1);

    return last;
  };

  const deliver = (event: JetstreamEvent): void => {
    for (const { filter, listener } of subscribers) {
      if (matches(filter, event)) {
        listener(event);
      }
    }
  };

  const publish = (event: JetstreamEvent): void => {
    events.push(event);

    if (events.length > RETAIN) {
      events.splice(0, events.length - RETAIN);
    }

    if (paused) {
      held.push(event);
    } else {
      deliver(event);
    }
  };

  const commits = ({
    repo: did,
    rev,
    blocks: car,
    ops
  }: v.InferOutput<typeof commitSchema>): void => {
    const blocks = new Map<string, Uint8Array>();

    for (const entry of fromUint8Array(CBOR.fromBytes(car))) {
      blocks.set(CID.toString(entry.cid), entry.bytes);
    }

    for (const op of ops) {
      const [collection = "", rkey = ""] = op.path.split("/");
      const cid = op.cid?.$link;
      const block = cid === undefined ? undefined : blocks.get(cid);

      publish({
        did,
        time_us: now(),
        kind: "commit",
        commit: {
          rev,
          operation: op.action,
          collection,
          rkey,
          ...(op.action !== "delete" &&
            cid !== undefined &&
            block && { record: asJson(CBOR.decode(block)), cid })
        }
      });
    }
  };

  return {
    ingest(frame) {
      const decoded = frameOf(frame);

      if (decoded?.type === "#commit") {
        const commit = v.safeParse(commitSchema, decoded.body);

        if (commit.success && !ignored.has(commit.output.repo)) {
          commits(commit.output);
        }
      } else if (decoded?.type === "#identity") {
        const identity = v.safeParse(identitySchema, decoded.body);

        if (identity.success && !ignored.has(identity.output.did)) {
          publish({
            did: identity.output.did,
            time_us: now(),
            kind: "identity",
            identity: identity.output
          });
        }
      } else if (decoded?.type === "#account") {
        const account = v.safeParse(accountSchema, decoded.body);

        if (account.success && !ignored.has(account.output.did)) {
          publish({
            did: account.output.did,
            time_us: now(),
            kind: "account",
            account: account.output
          });
        }
      }
    },
    subscribe(filter, listener) {
      const subscriber = { filter, listener };

      if (filter.cursor !== undefined) {
        const from = filter.cursor;

        for (const event of events) {
          if (
            event.time_us >= from &&
            !held.includes(event) &&
            matches(filter, event)
          ) {
            listener(event);
          }
        }
      }

      subscribers.add(subscriber);

      return () => {
        subscribers.delete(subscriber);
      };
    },
    pause() {
      paused = true;
    },
    resume() {
      paused = false;

      const release = held;

      held = [];

      for (const event of release) {
        deliver(event);
      }
    },
    ignore(did) {
      ignored.add(did);
    },
    heed(did) {
      ignored.delete(did);
    },
    get state() {
      return { paused, ignored: [...ignored] };
    }
  };
};
