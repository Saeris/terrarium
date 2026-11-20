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
    const response = await terrarium.fetch(
      new Request(request.url(), {
        method: request.method(),
        headers,
        ...(body !== null && body.length > 0 && { body })
      })
    );
    const fulfilled: Record<string, string> = {};

    for (const [name, value] of response.headers) {
      fulfilled[name] = value;
    }

    const cookies = response.headers.getSetCookie();

    // Playwright splits set-cookie on newlines; joined with commas, as Headers would, cookies with dates break.
    if (cookies.length > 0) {
      fulfilled["set-cookie"] = cookies.join("\n");
    }

    await intercepted.fulfill({
      status: response.status,
      headers: fulfilled,
      body: Buffer.from(await response.arrayBuffer())
    });
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
