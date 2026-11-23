import type {
  Filter,
  Jetstream,
  JetstreamClient,
  JetstreamConnection,
  JetstreamEvent
} from "./jetstream";

/**
 * Jetstream's v2 stream, `network.bsky.jetstream.subscribeEvents`: the same events as `/subscribe`, in the lexicon's shape. Each frame is `{ $type: "message", payload }`, every event carries a `seq` to resume from, and the filters are `kinds`, `dids` and `collections`. It's server-push only.
 *
 * Where Bluesky's refuses a request with an HTTP 400 before the socket opens (`CursorTooOld`, `InvalidRequest`), this one has already opened it, so it closes it at once with code 1008 and the error's name and message as the reason. Not emulated: compression (`zstdDictionary` is refused), `maxMessageSizeBytes` (ignored), and `#sync` events, which the sandbox's PDSes don't send.
 */

export const SUBSCRIBE_EVENTS = "/xrpc/network.bsky.jetstream.subscribeEvents";

const ID = "network.bsky.jetstream.subscribeEvents";
const KINDS = new Set(["commit", "identity", "account", "sync"]);
/** A cursor this large is a time in unix microseconds, not a seq. */
const TIMESTAMP = 1e15;
/** v1's parameter names, which v2 refuses, naming the replacement. */
const RENAMED = { wantedDids: "dids", wantedCollections: "collections" };

interface Refused {
  readonly error: string;
  readonly message: string;
}

interface Notice {
  readonly name: "OutdatedCursor" | "FutureCursor";
  readonly message: string;
}

interface Asked {
  readonly filter: Filter;
  /** Sent before any event, as v2's first frame. */
  readonly notice?: Notice;
}

/** RFC 3339 with microseconds, as v2 writes every time. */
const timeOf = (micros: number): string =>
  `${new Date(Math.floor(micros / 1000)).toISOString().slice(0, -1)}${String(micros % 1000).padStart(3, "0")}Z`;

const invalid = (message: string): Refused => ({
  error: "InvalidRequest",
  message
});

const askedFor = (url: URL, jetstream: Jetstream): Asked | Refused => {
  const { searchParams: query } = url;

  for (const [old, replacement] of Object.entries(RENAMED)) {
    if (query.has(old)) {
      return invalid(`v2 takes ${replacement}, not ${old}.`);
    }
  }

  const kinds = query.getAll("kinds");
  const unknown = kinds.find((kind) => !KINDS.has(kind));
  const collections = query.getAll("collections");

  if (unknown !== undefined) {
    return invalid(
      `${unknown} isn't a kind: commit, identity, account or sync.`
    );
  }

  if (collections.length > 0 && kinds.length > 0 && !kinds.includes("commit")) {
    return invalid("collections filters commits, which kinds leaves out.");
  }

  if (query.has("zstdDictionary")) {
    return {
      error: "UnknownZstdDictionary",
      message: "Terrarium's Jetstream doesn't compress."
    };
  }

  const filter: Filter = {
    wantedDids: query.getAll("dids"),
    wantedCollections: collections,
    kinds
  };
  const cursor = query.get("cursor");

  if (cursor === null) {
    return { filter };
  }

  const position = Number(cursor);
  const { floor, next, since } = jetstream.history;

  if (!Number.isSafeInteger(position)) {
    return invalid(`cursor is an integer, not ${cursor}.`);
  }

  if (position >= TIMESTAMP) {
    return position < since
      ? {
          filter: { ...filter, seq: floor },
          notice: {
            name: "OutdatedCursor",
            message: `Nothing before ${timeOf(since)} is kept: resuming from seq ${String(floor)}.`
          }
        }
      : { filter: { ...filter, seq: jetstream.seqAt(position) } };
  }

  if (position < floor) {
    return {
      error: "CursorTooOld",
      message: `The oldest event kept is seq ${String(floor)}.`
    };
  }

  if (position > next) {
    return {
      filter,
      notice: {
        name: "FutureCursor",
        message: `seq ${cursor} hasn't happened: starting at the live tip, seq ${String(next)}.`
      }
    };
  }

  return { filter: { ...filter, seq: position } };
};

/** An event as v2's lexicon has it. */
const payloadOf = (event: JetstreamEvent, seq: number): object => {
  const time = timeOf(event.time_us);
  const common = { seq, did: event.did, time, witnessedAt: time };

  switch (event.kind) {
    case "commit": {
      const { record, cid, ...commit } = event.commit;

      return {
        $type: `${ID}#commit`,
        ...common,
        ...commit,
        ...(record !== undefined && { record }),
        ...(cid !== undefined && { cid })
      };
    }
    case "identity": {
      return { $type: `${ID}#identity`, ...common, identity: event.identity };
    }
    case "account": {
      return { $type: `${ID}#account`, ...common, account: event.account };
    }
  }
};

const frame = (payload: object): string =>
  JSON.stringify({ $type: "message", payload });

/** A client subscribing at the v2 path. */
export const subscribeEvents = (
  jetstream: Jetstream,
  url: URL,
  client: JetstreamClient
): JetstreamConnection => {
  const asked = askedFor(url, jetstream);

  if ("error" in asked) {
    // A close reason is at most 123 bytes.
    client.close(1008, `${asked.error}: ${asked.message}`.slice(0, 123));

    return {
      receive() {
        // Already closed.
      },
      close() {
        // Nothing was subscribed.
      }
    };
  }

  if (asked.notice) {
    client.send(frame({ $type: `${ID}#info`, ...asked.notice }));
  }

  let stop: (() => void) | undefined = jetstream.subscribe(
    asked.filter,
    (event, seq) => {
      client.send(frame(payloadOf(event, seq)));
    }
  );
  const close = (): void => {
    stop?.();
    stop = undefined;
  };

  return {
    receive() {
      close();
      client.close(1008, "v2 is server-push only: a client's frame ends it.");
    },
    close
  };
};
