import { chromium, type Browser, type BrowserContext } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { route } from "../playwright";
import { createTerrarium, type Account, type Terrarium } from "../terrarium";

/**
 * Most of what an ATProto app does happens in a browser: it resolves identities, reads PDSes, sends people to their PDS to sign in, and follows Jetstream, all at real addresses. Behind `route`, a Playwright page does all of that against the sandbox without being told, and can navigate to an account's PDS as an OAuth redirect would.
 */

const NOTE = "dev.terrarium.test.note";

describe("terrarium inside a Playwright browser", () => {
  let terrarium: Terrarium;
  let alice: Account;
  let browser: Browser;
  let context: BrowserContext;

  beforeAll(async () => {
    terrarium = await createTerrarium();
    alice = await terrarium.createAccount({ name: "alice" });
    await terrarium.seed("alice", [
      { collection: NOTE, rkey: "hello", record: { text: "hello, browser" } }
    ]);
    browser = await chromium.launch();
    context = await browser.newContext();
    await route(context, terrarium);
  }, 60_000);

  afterAll(async () => {
    await browser.close();
    await terrarium.dispose();
  });

  it("navigates to an account's PDS, as an OAuth redirect does", async () => {
    const page = await context.newPage();
    const response = await page.goto(
      `${alice.endpoint}/xrpc/com.atproto.repo.describeRepo?repo=${alice.did}`
    );

    expect(response?.status()).toBe(200);
    await expect(response?.json()).resolves.toMatchObject({
      did: alice.did,
      handle: "alice.test"
    });
  });

  it("resolves and reads from inside the page, at plc.directory and the PDS its DID names", async () => {
    const page = await context.newPage();

    await page.goto(`${alice.endpoint}/`);

    const text = await page.evaluate(async (did) => {
      const document = (await (
        await fetch(`https://plc.directory/${did}`)
      ).json()) as { service: { serviceEndpoint: string }[] };
      const pds = document.service[0]?.serviceEndpoint ?? "";
      const record = (await (
        await fetch(
          `${pds}/xrpc/com.atproto.repo.getRecord?repo=${did}&collection=dev.terrarium.test.note&rkey=hello`
        )
      ).json()) as { value: { text: string } };

      return record.value.text;
    }, alice.did);

    expect(text).toBe("hello, browser");
  });

  it("follows Jetstream at Bluesky's address from inside the page", async () => {
    const page = await context.newPage();

    await page.goto(`${alice.endpoint}/`);

    const arrived = page.evaluate(
      async (did) =>
        new Promise<string>((resolve) => {
          const socket = new WebSocket(
            `wss://jetstream2.us-east.bsky.network/subscribe?wantedDids=${did}`
          );

          socket.addEventListener("message", (event: { data: unknown }) => {
            const message = JSON.parse(String(event.data)) as {
              commit?: { record?: { text?: string } };
            };

            if (message.commit?.record?.text === "seen by the page") {
              resolve("seen by the page");
            }
          });
        }),
      alice.did
    );

    // Long enough for the page to have connected before the write.
    await page.waitForTimeout(500);
    await terrarium.seed("alice", [
      { collection: NOTE, record: { text: "seen by the page" } }
    ]);

    await expect(arrived).resolves.toBe("seen by the page");
  });
});
