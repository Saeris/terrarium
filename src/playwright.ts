import type { BrowserContext, Page, Route } from "playwright-core";
import { JETSTREAM_HOSTS } from "./hosts";
import { filterFrom } from "./jetstream";
import type { Terrarium } from "./terrarium";

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

export const route = async (
  target: BrowserContext | Page,
  terrarium: Terrarium
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
      const stop = terrarium.jetstream.subscribe(
        filterFrom(new URL(socket.url())),
        (event) => {
          socket.send(JSON.stringify(event));
        }
      );

      socket.onClose(stop);
    }
  );
};
