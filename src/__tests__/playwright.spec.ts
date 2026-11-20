import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
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

  it("follows a redirect from an app to a PDS, as a sign-in does, keeping the app's cookie", async () => {
    terrarium.mount("app.example.internal", async (request) =>
      new URL(request.url).pathname === "/sign-in"
        ? new Response(null, {
            status: 302,
            headers: {
              location: `${alice.endpoint}/xrpc/com.atproto.repo.describeRepo?repo=${alice.did}`,
              "set-cookie": "state=abc; Path=/; Secure; HttpOnly"
            }
          })
        : new Response("app")
    );

    const page = await context.newPage();

    await page.goto("https://app.example.internal/sign-in");
    await page.waitForURL((url) => url.hostname === "alice.terrarium.test");

    await expect(page.locator("body").innerText()).resolves.toContain(
      alice.did
    );
    await expect(
      context.cookies("https://app.example.internal")
    ).resolves.toMatchObject([{ name: "state", value: "abc" }]);
  });

  it("follows a redirect inside fetch, as the browser would", async () => {
    terrarium.mount("api.example.internal", async (request) =>
      new URL(request.url).pathname === "/moved"
        ? new Response(null, {
            status: 303,
            headers: { location: "https://api.example.internal/here" }
          })
        : new Response("arrived", {
            headers: { "access-control-allow-origin": "*" }
          })
    );

    const page = await context.newPage();

    await page.goto(`${alice.endpoint}/`);

    await expect(
      page.evaluate(async () =>
        (await fetch("https://api.example.internal/moved")).text()
      )
    ).resolves.toBe("arrived");
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

  it("keeps the page off the internet when asked, but not off this machine, where the app under test runs", async () => {
    const local = createServer((_, response) => {
      response.end("local");
    });

    await new Promise<void>((resolve) => {
      local.listen(0, "127.0.0.1", resolve);
    });

    const { port } = local.address() as AddressInfo;
    const strict = await browser.newContext();

    await route(strict, terrarium, { unowned: "refuse" });

    const page = await strict.newPage();

    expect((await page.goto("https://example.com/"))?.status()).toBe(502);
    expect((await page.goto(`http://127.0.0.1:${port}/`))?.status()).toBe(200);
    await expect(
      page.evaluate(
        async () =>
          new Promise<number>((resolve) => {
            new WebSocket("wss://example.com/").addEventListener(
              "close",
              (event) => {
                resolve(event.code);
              }
            );
          })
      )
    ).resolves.toBe(1008);

    await strict.close();
    local.close();
  });
});
