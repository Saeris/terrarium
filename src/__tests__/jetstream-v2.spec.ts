import { setupServer } from "msw/node";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { intercept } from "../intercept";
import { handlers } from "../msw";
import { startServer } from "../server";
import {
  createTerrarium,
  type Account,
  type SocketLike,
  type Terrarium
} from "../terrarium";

/**
 * Bluesky's Jetstream has a second stream, `network.bsky.jetstream.subscribeEvents`, which `@bsky/jetstream` reads. An app moving to it has to find the sandbox speaking it as Bluesky's does: the lexicon's frames, a `seq` to resume from inclusively, its filters, and its refusals, which are what tell a client its cursor is too old or its query is v1's. Every way into the sandbox has to carry it, as each carries `/subscribe`.
 */

const V2 =
  "wss://jetstream2.us-east.bsky.network/xrpc/network.bsky.jetstream.subscribeEvents";
const ID = "network.bsky.jetstream.subscribeEvents";
const NOTE = "dev.terrarium.test.note";
const OTHER = "dev.terrarium.test.other";
const MICROSECONDS = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/u;

interface Frame {
  readonly $type: string;
  readonly payload: {
    readonly $type: string;
    readonly seq?: number;
    readonly did?: string;
    readonly record?: { readonly text?: string };
  };
}

interface Closed {
  readonly code: number;
  readonly reason: string;
}

/** Every frame a client gets, parsed, a way to wait for the next, and how the socket closed. */
const stream = (
  socket: SocketLike
): {
  readonly frames: Frame[];
  readonly closed: Promise<Closed>;
  next(): Promise<Frame>;
} => {
  const frames: Frame[] = [];
  const queue: Frame[] = [];
  const waiting: ((frame: Frame) => void)[] = [];

  socket.onmessage = ({ data }): void => {
    const frame = JSON.parse(data) as Frame;
    const waiter = waiting.shift();

    frames.push(frame);

    if (waiter) {
      waiter(frame);
    } else {
      queue.push(frame);
    }
  };

  return {
    frames,
    closed: new Promise((resolve) => {
      socket.onclose = resolve;
    }),
    next: async () =>
      new Promise((resolve) => {
        const queued = queue.shift();

        if (queued) {
          resolve(queued);
        } else {
          waiting.push(resolve);
        }
      })
  };
};

/** The texts of the commits among the frames. */
const texts = (frames: readonly Frame[]): (string | undefined)[] =>
  frames
    .filter(({ payload }) => payload.$type === `${ID}#commit`)
    .map(({ payload }) => payload.record?.text);

/** Lets the firehose reach Jetstream, and queued deliveries run, before asserting. */
const settle = async (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 300);
  });

/** The first message on a real (or intercepted) WebSocket, parsed, or how it closed. */
const firstOn = async (socket: WebSocket): Promise<Frame | Closed> =>
  new Promise((resolve) => {
    socket.addEventListener("message", (event: { data: unknown }) => {
      resolve(JSON.parse(String(event.data)) as Frame);
    });
    socket.addEventListener("close", ({ code, reason }) => {
      resolve({ code, reason });
    });
  });

describe("jetstream's v2 stream", () => {
  let terrarium: Terrarium;
  let alice: Account;
  let bob: Account;

  const subscribe = async (
    query: string
  ): Promise<ReturnType<typeof stream> & { readonly socket: SocketLike }> => {
    const socket = terrarium.connect(`${V2}?${query}`);
    const feed = stream(socket);

    await new Promise<void>((resolve) => {
      socket.onopen = (): void => {
        resolve();
      };
    });

    return { ...feed, socket };
  };

  const note = async (
    account: Account,
    text: string,
    collection = NOTE
  ): Promise<void> => {
    await terrarium.seed(account.name, [{ collection, record: { text } }]);
  };

  beforeAll(async () => {
    terrarium = await createTerrarium();
    alice = await terrarium.createAccount({ name: "alice" });
    bob = await terrarium.createAccount({ name: "bob" });
  }, 60_000);

  afterAll(async () => {
    await terrarium.dispose();
  });

  it("frames each event as the lexicon says, with the seq a client resumes from, and nothing of v1's shape", async () => {
    const feed = await subscribe(`dids=${alice.did}`);
    const arrived = feed.next();

    await note(alice, "on the stream");

    await expect(arrived).resolves.toEqual({
      $type: "message",
      payload: {
        $type: `${ID}#commit`,
        seq: expect.any(Number),
        did: alice.did,
        time: expect.stringMatching(MICROSECONDS),
        witnessedAt: expect.stringMatching(MICROSECONDS),
        rev: expect.any(String),
        operation: "create",
        collection: NOTE,
        rkey: expect.any(String),
        cid: expect.any(String),
        record: { $type: NOTE, text: "on the stream" }
      }
    });
    feed.socket.close();
  });

  it("resumes from a seq inclusively, so a client that drops misses nothing", async () => {
    const live = await subscribe(`dids=${bob.did}`);
    const first = live.next();

    await note(bob, "while connected");

    const { seq } = (await first).payload;

    live.socket.close();
    await note(bob, "while away");

    const resumed = await subscribe(`dids=${bob.did}&cursor=${String(seq)}`);

    await settle();

    expect(texts(resumed.frames)).toEqual(["while connected", "while away"]);
    resumed.socket.close();
  });

  it("refuses a seq older than what it keeps, rather than skip what was dropped", async () => {
    const feed = await subscribe("cursor=0");

    await expect(feed.closed).resolves.toEqual({
      code: 1008,
      reason: expect.stringMatching(/^CursorTooOld: /u)
    });
    expect(feed.frames).toEqual([]);
  });

  it("resumes from a time, as the first event at or after it", async () => {
    const since = Date.now() * 1000;

    await note(alice, "after the time");
    await settle();

    const feed = await subscribe(`dids=${alice.did}&cursor=${String(since)}`);

    await settle();

    expect(feed.frames.map(({ payload }) => payload.$type)).toEqual([
      `${ID}#commit`
    ]);
    expect(texts(feed.frames)).toEqual(["after the time"]);
    feed.socket.close();
  });

  it("says first when a time is older than what it keeps, then resumes from the oldest it has", async () => {
    const feed = await subscribe(`dids=${alice.did}&cursor=${String(1e15)}`);

    await settle();

    const [notice, ...events] = feed.frames;

    expect(notice).toEqual({
      $type: "message",
      payload: {
        $type: `${ID}#info`,
        name: "OutdatedCursor",
        message: expect.stringContaining("resuming from seq")
      }
    });
    expect(texts(events)).toEqual(["on the stream", "after the time"]);
    feed.socket.close();
  });

  it("says first when a seq hasn't happened yet, then carries on live", async () => {
    const feed = await subscribe(`dids=${alice.did}&cursor=${String(1e14)}`);
    const notice = await feed.next();
    const arrived = feed.next();

    await note(alice, "live");

    expect(notice.payload).toMatchObject({
      $type: `${ID}#info`,
      name: "FutureCursor"
    });
    await expect(arrived).resolves.toMatchObject({
      payload: { record: { text: "live" } }
    });
    feed.socket.close();
  });

  it("filters by kind, account and collection, the collections narrowing only commits", async () => {
    const commits = await subscribe(
      `kinds=commit&dids=${alice.did}&collections=${NOTE}`
    );
    const everything = await subscribe(`dids=${alice.did}&collections=${NOTE}`);

    await note(alice, "elsewhere", OTHER);
    await note(alice, "wanted");

    // Alice's PDS tells the network her identity changed, as it does after a handle change.
    const session = (await (
      await terrarium.fetch(
        new Request(`${alice.endpoint}/xrpc/com.atproto.server.createSession`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            identifier: alice.did,
            password: alice.password
          })
        })
      )
    ).json()) as { accessJwt: string };

    await terrarium.fetch(
      new Request(
        `${alice.endpoint}/xrpc/gg.mk.experimental.emitIdentityEvent`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${session.accessJwt}` }
        }
      )
    );
    await settle();

    expect(commits.frames.map(({ payload }) => payload.$type)).toEqual([
      `${ID}#commit`
    ]);
    expect(texts(commits.frames)).toEqual(["wanted"]);
    // A collections filter narrows commits, and lets every other kind through.
    expect(everything.frames.map(({ payload }) => payload.$type)).toEqual([
      `${ID}#commit`,
      `${ID}#identity`
    ]);
    expect(everything.frames[1]?.payload).toMatchObject({
      did: alice.did,
      identity: { did: alice.did, seq: expect.any(Number) }
    });
    commits.socket.close();
    everything.socket.close();
  });

  it.each([
    [
      "v1's names",
      `wantedDids=did:plc:x`,
      "InvalidRequest: v2 takes dids, not wantedDids."
    ],
    ["an unknown kind", "kinds=likes", "InvalidRequest: likes isn't a kind"],
    [
      "collections with kinds that leave commits out",
      `kinds=identity&collections=${NOTE}`,
      "InvalidRequest: collections"
    ],
    ["compression", "zstdDictionary=1", "UnknownZstdDictionary"]
  ])("refuses %s, saying so", async (_, query, reason) => {
    const feed = await subscribe(query);

    await expect(feed.closed).resolves.toEqual({
      code: 1008,
      reason: expect.stringContaining(reason)
    });
  });

  it("ends the stream when the client sends anything, being server-push only", async () => {
    const feed = await subscribe(`dids=${alice.did}`);

    feed.socket.send(JSON.stringify({ type: "options_update" }));

    await expect(feed.closed).resolves.toMatchObject({ code: 1008 });
  });

  it("is at Bluesky's address under Mock Service Worker", async () => {
    const server = setupServer(...handlers(terrarium));

    server.listen();

    try {
      const since = Date.now() * 1000;

      await note(alice, "through MSW");
      await settle();

      const socket = new WebSocket(
        `${V2}?dids=${alice.did}&cursor=${String(since)}`
      );

      await expect(firstOn(socket)).resolves.toMatchObject({
        payload: { $type: `${ID}#commit`, record: { text: "through MSW" } }
      });
      socket.close();
    } finally {
      server.close();
    }
  });

  it("is at Bluesky's address for a process pointed at a running sandbox, refusals and all", async () => {
    const server = await startServer({
      port: 27_700,
      ports: { plc: 27_710, jetstream: 27_720, pds: 27_800 }
    });
    const interception = await intercept({
      control: server.url,
      unowned: "network"
    });

    try {
      const dave = await server.terrarium.createAccount({ name: "dave" });
      const since = Date.now() * 1000;

      await server.terrarium.seed("dave", [
        { collection: NOTE, record: { text: "through the port" } }
      ]);
      await settle();

      const socket = new WebSocket(
        `${V2}?dids=${dave.did}&cursor=${String(since)}`
      );

      await expect(firstOn(socket)).resolves.toMatchObject({
        payload: { $type: `${ID}#commit`, record: { text: "through the port" } }
      });
      socket.close();

      await expect(firstOn(new WebSocket(`${V2}?cursor=0`))).resolves.toEqual({
        code: 1008,
        reason: expect.stringMatching(/^CursorTooOld: /u)
      });
    } finally {
      interception.close();
      await server.close();
    }
  }, 60_000);
});
