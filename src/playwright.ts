import type { BrowserContext, Page, Route } from "playwright-core";
import { JETSTREAM_HOSTS, isLoopback, refuse, type Unowned } from "./hosts";
import { accept, SUBSCRIBE } from "./jetstream";
import { SUBSCRIBE_EVENTS } from "./jetstream-v2";
import type { Account, Terrarium } from "./terrarium";

/**
 * Terrarium inside a Playwright browser: every request a page makes to an address Terrarium owns is answered by the sandbox, including top-level navigations, so an OAuth redirect to an account's PDS lands on that PDS's real sign-in page. Bluesky's Jetstream addresses are answered too, over WebSocket. Nothing else is touched.
 *
 *     await route(context, terrarium);
 *     await page.goto("https://your.app/");
 *
 * The page needs no configuration and can't tell: there's no TLS or DNS involved, because Playwright hands the request over before it reaches the network.
 */
const REDIRECTS: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** As many redirects as a browser follows before giving up. */
const MAX_REDIRECTS = 20;

interface Fulfilment {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: Buffer | string;
}

/** A response's cookies, as Playwright takes them: separate cookies on separate lines. Joined with commas, as `Headers` joins them, a cookie with an expiry date breaks. */
const cookiesOf = (response: Response): Record<string, string> => {
  const cookies = response.headers.getSetCookie();

  return cookies.length > 0 ? { "set-cookie": cookies.join("\n") } : {};
};

const fulfilment = async (response: Response): Promise<Fulfilment> => ({
  status: response.status,
  headers: {
    ...Object.fromEntries(response.headers),
    ...cookiesOf(response)
  },
  body: Buffer.from(await response.arrayBuffer())
});

const attribute = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

/** A redirect, as a page that goes there itself. */
const hop = (to: string, response: Response): Fulfilment => ({
  status: 200,
  headers: {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    ...cookiesOf(response)
  },
  body: `<!doctype html><meta http-equiv="refresh" content="0;url=${attribute(to)}"><script>location.replace(${JSON.stringify(to)})</script>`
});

/** Follow a redirect chain as a browser does: 307 and 308 keep the method and body, the rest become a GET. Terrarium answers what it owns; the rest goes to the network. */
const follow = async (
  first: Request,
  firstResponse: Response,
  terrarium: Terrarium
): Promise<Response> => {
  let request = first;
  let response = firstResponse;

  for (let hops = 0; hops < MAX_REDIRECTS; hops++) {
    const location = REDIRECTS.has(response.status)
      ? response.headers.get("location")
      : null;

    if (location === null) {
      return response;
    }

    const keep = response.status === 307 || response.status === 308;
    const body = keep ? await request.clone().arrayBuffer() : undefined;

    request = new Request(new URL(location, request.url), {
      method: keep ? request.method : "GET",
      headers: request.headers,
      redirect: "manual",
      ...(body !== undefined && body.byteLength > 0 && { body })
    });
    response = terrarium.owns(request.url)
      ? await terrarium.fetch(request)
      : await fetch(request);
  }

  return response;
};

export interface RouteOptions {
  /** What to do with a request the page makes to an address Terrarium doesn't own, other than this machine's: let it through (the default), or refuse it, a 502 for a request and a closed socket for a WebSocket. */
  readonly unowned?: Unowned;
}

export const route = async (
  target: BrowserContext | Page,
  terrarium: Terrarium,
  { unowned = "network" }: RouteOptions = {}
): Promise<void> => {
  const answer = async (intercepted: Route): Promise<void> => {
    const request = intercepted.request();
    const body = request.postDataBuffer();
    const headers = Object.entries(await request.allHeaders()).filter(
      // HTTP/2 pseudo-headers aren't headers a Request can carry.
      ([name]) => !name.startsWith(":")
    );
    const first = new Request(request.url(), {
      method: request.method(),
      headers,
      redirect: "manual",
      ...(body !== null && body.length > 0 && { body })
    });
    // A copy goes to Terrarium, so a 307 can send the body again.
    const response = await terrarium.fetch(first.clone());
    const location = REDIRECTS.has(response.status)
      ? response.headers.get("location")
      : null;

    if (location === null) {
      await intercepted.fulfill(await fulfilment(response));

      return;
    }

    if (request.isNavigationRequest()) {
      // Chromium won't route the request that follows a redirect Playwright fulfilled; it goes straight to DNS. So the page goes there itself, making a request that is routed, and the redirect's cookies are kept.
      await intercepted.fulfill(
        hop(new URL(location, request.url()).href, response)
      );

      return;
    }

    // `fetch` and XHR follow redirects inside the browser, out of reach of the same problem: follow them here, as the browser would.
    await intercepted.fulfill(
      await fulfilment(await follow(first, response, terrarium))
    );
  };

  await target.route((url) => terrarium.owns(url), answer);
  await target.routeWebSocket(
    (url) => JETSTREAM_HOSTS.has(url.hostname),
    (socket) => {
      const connection = accept(terrarium.jetstream, new URL(socket.url()), {
        send(frame) {
          socket.send(frame);
        },
        close(code, reason) {
          void socket.close({ code, reason });
        }
      });

      if (!connection) {
        void socket.close({
          code: 1008,
          reason: `Jetstream subscribes at ${SUBSCRIBE} or ${SUBSCRIBE_EVENTS}.`
        });

        return;
      }

      socket.onMessage(() => {
        connection.receive();
      });
      socket.onClose(() => {
        connection.close();
      });
    }
  );

  if (unowned === "refuse") {
    const outside = (url: URL): boolean =>
      !terrarium.owns(url) && !isLoopback(url.hostname);

    await target.route(outside, async (intercepted) => {
      await intercepted.fulfill({
        status: 502,
        body: refuse(intercepted.request().url())
      });
    });
    await target.routeWebSocket(outside, async (socket) => {
      refuse(socket.url());
      await socket.close({ code: 1008, reason: "Refused by Terrarium" });
    });
  }
};

/**
 * Sign an account in on its PDS's own page, as a person would, once the app under test has sent the page there: the password, then Allow. Resolves when the PDS has sent the page back to the app. When the PDS won't let it through, it throws with what the page says, rather than leaving a test to time out on a page that never moves.
 *
 *     await page.getByRole("button", { name: "Sign in" }).click();
 *     await signIn(page, alice);
 *     await expect(page.getByText("Signed in as alice.test")).toBeVisible();
 */
export const signIn = async (page: Page, account: Account): Promise<void> => {
  const onPds = (url: URL): boolean => url.origin === account.endpoint;

  await page.waitForURL(
    (url) => onPds(url) && url.pathname === "/oauth/authorize"
  );

  const allow = page.getByRole("button", { name: "Allow" });

  // An authorization the PDS refused outright (an unknown client, a redirect the client doesn't list) gets a page with no form.
  if ((await allow.count()) === 0) {
    throw new Error(
      `${account.handle}'s PDS refused the authorization: ${await page.locator("body").innerText()}`
    );
  }

  if (await allow.isDisabled()) {
    throw new Error(
      `${account.handle}'s PDS can't show everything the app asks for: ${await page.locator(".permissions-warning").innerText()}`
    );
  }

  await page.getByPlaceholder("Password").fill(account.password);

  await allow.click();

  const refusal = page.locator(".error-message");
  const leaves = async (): Promise<undefined> => {
    await page.waitForURL((url) => !onPds(url));

    return undefined;
  };
  const refused = async (): Promise<string> => {
    await refusal.waitFor();

    return refusal.innerText();
  };
  let reason: string | undefined;

  try {
    // Only one of them happens: the other gives up when the page goes, unheard.
    reason = await Promise.any([leaves(), refused()]);
  } catch (error) {
    throw new Error(
      `${account.handle}'s PDS kept the page, without saying why.`,
      { cause: error }
    );
  }

  if (reason !== undefined) {
    throw new Error(`${account.handle}'s PDS refused the sign-in: ${reason}`);
  }
};
