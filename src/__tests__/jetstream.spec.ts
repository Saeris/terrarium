import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { JetstreamEvent } from "../jetstream";
import {
  createTerrarium,
  type Account,
  type SocketLike,
  type Terrarium
} from "../terrarium";

/**
 * Apps follow changes through Jetstream, so the sandbox's has to say what Bluesky's says: the same events, filtered the same way, resumable from a cursor. And it has to be able to misbehave on purpose, because a relay that falls behind or stops carrying an account is what broke Taproom's boards in production.
 */

const NOTE = "dev.terrarium.test.note";
const OTHER = "dev.terrarium.test.other";

/** Every message a client gets, parsed, as a client would. */
const listen = (
  socket: SocketLike
): { readonly events: JetstreamEvent[]; next(): Promise<JetstreamEvent> } => {
  const events: JetstreamEvent[] = [];
  let waiting: ((event: JetstreamEvent) => void) | undefined;

  socket.onmessage = ({ data }): void => {
    const event = JSON.parse(data) as JetstreamEvent;

    events.push(event);
    waiting?.(event);
    waiting = undefined;
  };

  return {
    events,
    next: async () =>
      new Promise((resolve) => {
        waiting = resolve;
      })
  };
};

const opened = async (socket: SocketLike): Promise<void> =>
  new Promise((resolve) => {
    socket.onopen = resolve;
  });

/** Lets queued deliveries run before asserting nothing arrived. */
const settle = async (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 200);
  });

describe("the sandbox's Jetstream", () => {
  let terrarium: Terrarium;
  let alice: Account;
  let bob: Account;

  const subscribe = async (query: string): Promise<SocketLike> => {
    const socket = terrarium.connect(`${terrarium.jetstreamUrl}?${query}`);

    await opened(socket);

    return socket;
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

  it("delivers a write as Jetstream's commit event, record and all", async () => {
    const socket = await subscribe(`wantedDids=${alice.did}`);
    const feed = listen(socket);
    const arrived = feed.next();

    await note(alice, "on the stream");

    await expect(arrived).resolves.toMatchObject({
      did: alice.did,
      kind: "commit",
      commit: {
        operation: "create",
        collection: NOTE,
        record: { $type: NOTE, text: "on the stream" }
      }
    });
    socket.close();
  });

  it("sends only the accounts and collections a client asked for", async () => {
    const socket = await subscribe(
      `wantedDids=${alice.did}&wantedCollections=${NOTE}`
    );
    const feed = listen(socket);

    await note(bob, "not alice");
    await note(alice, "wrong collection", OTHER);
    await note(alice, "this one");
    await settle();

    expect(
      feed.events.map((event) => event.kind === "commit" && event.commit.record)
    ).toEqual([{ $type: NOTE, text: "this one" }]);
    socket.close();
  });

  it("replays from a cursor, so a client that drops misses nothing", async () => {
    const before = listen(await subscribe(`wantedDids=${bob.did}`));
    const first = before.next();

    await note(bob, "while connected");

    const { time_us: cursor } = await first;

    await note(bob, "while away");

    const resumed = listen(
      await subscribe(`wantedDids=${bob.did}&cursor=${String(cursor + 1)}`)
    );

    await settle();

    expect(
      resumed.events.map(
        (event) => event.kind === "commit" && event.commit.record
      )
    ).toEqual([{ $type: NOTE, text: "while away" }]);
  });

  it("can stop carrying an account, as the relay did with Taproom's venue PDS, and the account's writes are simply never seen", async () => {
    const feed = listen(await subscribe(`wantedDids=${alice.did}`));

    terrarium.jetstream.ignore(alice.did);
    await note(alice, "lost to the relay");
    await settle();
    terrarium.jetstream.heed(alice.did);

    const after = feed.next();

    await note(alice, "carried again");

    await expect(after).resolves.toMatchObject({
      commit: { record: { text: "carried again" } }
    });
    expect(feed.events).toHaveLength(1);
  });

  it("can fall behind and catch up, holding events back until it resumes", async () => {
    const feed = listen(await subscribe(`wantedDids=${bob.did}`));

    terrarium.jetstream.pause();
    await note(bob, "delayed");
    await settle();

    expect(feed.events).toHaveLength(0);

    terrarium.jetstream.resume();
    await settle();

    expect(feed.events).toHaveLength(1);
  });
});
