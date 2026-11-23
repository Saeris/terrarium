import * as CBOR from "@atcute/cbor";
import { fromUint8Array } from "@atcute/car";
import * as CID from "@atcute/cid";
import { isCidLink, type CidLink } from "@atcute/cid";
import * as v from "valibot";
import { SUBSCRIBE_EVENTS, subscribeEvents } from "./jetstream-v2";

/**
 * Jetstream: every PDS's firehose turned into JSON events, filtered by DID and collection, with a microsecond cursor to resume from. The same events and query parameters as Bluesky's Jetstream, so a client written against it works here unchanged: its `/subscribe`, and its v2 stream (`./jetstream-v2`).
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
  /** Only these kinds of event (v2's `kinds`). Every kind when empty or left out. */
  readonly kinds?: readonly string[] | undefined;
  /** Replay from this seq, inclusive (v2's cursor), in place of `cursor`. */
  readonly seq?: number | undefined;
}

export interface Jetstream {
  /** One `subscribeRepos` frame from a PDS. */
  ingest(frame: Uint8Array): void;
  /** Events matching the filter, each with its seq: the replay first, then as they happen. Returns how to stop. */
  subscribe(
    filter: Filter,
    listener: (event: JetstreamEvent, seq: number) => void
  ): () => void;
  /** What it can replay: every event from seq `floor` up to `next` (the seq the next event gets), which is everything since `since` (unix microseconds). Before that, events were dropped, or happened before this Jetstream started. */
  readonly history: {
    readonly floor: number;
    readonly next: number;
    readonly since: number;
  };
  /** The seq of the first event kept at or after a time in unix microseconds; `next` if there's none yet. */
  seqAt(time: number): number;
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
  (filter.kinds === undefined ||
    filter.kinds.length === 0 ||
    filter.kinds.includes(event.kind)) &&
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

/** An event as it's kept: numbered in the order it happened. */
interface Logged {
  readonly seq: number;
  readonly event: JetstreamEvent;
}

export const createJetstream = (): Jetstream => {
  const events: Logged[] = [];
  const subscribers = new Set<{
    filter: Filter;
    listener: (event: JetstreamEvent, seq: number) => void;
  }>();
  const ignored = new Set<string>();
  const started = Date.now() * 1000;
  let paused = false;
  let held: Logged[] = [];
  let last = 0;
  let next = 1;
  let dropped = false;

  /** Microseconds since the epoch, never repeating and never going back: it's every subscriber's cursor. */
  const now = (): number => {
    last = Math.max(Date.now() * 1000, last + 1);

    return last;
  };

  const deliver = ({ seq, event }: Logged): void => {
    for (const { filter, listener } of subscribers) {
      if (matches(filter, event)) {
        listener(event, seq);
      }
    }
  };

  const publish = (event: JetstreamEvent): void => {
    const logged = { seq: next, event };

    next += 1;
    events.push(logged);

    if (events.length > RETAIN) {
      events.splice(0, events.length - RETAIN);
      dropped = true;
    }

    if (paused) {
      held.push(logged);
    } else {
      deliver(logged);
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

      const { seq: fromSeq, cursor: fromTime } = filter;

      if (fromSeq !== undefined || fromTime !== undefined) {
        for (const logged of events) {
          const { seq, event } = logged;

          if (
            (fromSeq === undefined
              ? event.time_us >= (fromTime ?? 0)
              : seq >= fromSeq) &&
            !held.includes(logged) &&
            matches(filter, event)
          ) {
            listener(event, seq);
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
    },
    get history() {
      const [oldest] = events;

      return {
        floor: oldest?.seq ?? next,
        next,
        since: dropped && oldest ? oldest.event.time_us : started
      };
    },
    seqAt(time) {
      return events.find(({ event }) => event.time_us >= time)?.seq ?? next;
    }
  };
};

/** Bluesky's Jetstream path, which Terrarium's `JetstreamEvent`s are the messages of. */
export const SUBSCRIBE = "/subscribe";

/** A client's end of a Jetstream socket, as each interceptor has it. */
export interface JetstreamClient {
  send(frame: string): void;
  close(code: number, reason: string): void;
}

/** What an interceptor tells Jetstream about the client. */
export interface JetstreamConnection {
  /** The client sent a frame. */
  receive(): void;
  /** The client went. */
  close(): void;
}

/**
 * A client opening a socket at `url`, answered in the protocol its path asks for: `/subscribe`, or v2's `/xrpc/network.bsky.jetstream.subscribeEvents`. Undefined for any other path, for the interceptor to refuse in its own way. Every interceptor goes through here, so they all speak both.
 */
export const accept = (
  jetstream: Jetstream,
  url: URL,
  client: JetstreamClient
): JetstreamConnection | undefined => {
  if (url.pathname === SUBSCRIBE_EVENTS) {
    return subscribeEvents(jetstream, url, client);
  }

  if (url.pathname !== SUBSCRIBE) {
    return undefined;
  }

  const stop = jetstream.subscribe(filterFrom(url), (event) => {
    client.send(JSON.stringify(event));
  });

  return {
    receive() {
      // v1's options_update isn't emulated: what a client sends is ignored.
    },
    close: stop
  };
};
