/**
 * The hostnames Terrarium answers for, as the network names them. A client under test keeps its real configuration (`plc.directory`, Bluesky's Jetstream) and an interceptor hands Terrarium whatever is addressed to these.
 */

/** Where did:plc documents live. */
export const PLC_HOST = "plc.directory";

/** Bluesky's public Jetstream instances: a client may be configured with any of them. */
export const JETSTREAM_HOSTS: ReadonlySet<string> = new Set([
  "jetstream1.us-east.bsky.network",
  "jetstream2.us-east.bsky.network",
  "jetstream1.us-west.bsky.network",
  "jetstream2.us-west.bsky.network"
]);

/** The Jetstream a client gets when it asks Terrarium where to subscribe. */
export const JETSTREAM_URL = "wss://jetstream2.us-east.bsky.network/subscribe";

/** Where each account's PDS lives: `https://<name>.terrarium.test`. `.test` is reserved, so a request that slips past an interceptor fails to resolve instead of reaching anything real. */
export const PDS_DOMAIN = "terrarium.test";

/** DNS-over-HTTPS services clients resolve handles' `_atproto` TXT records through. */
export const DOH_HOSTS: ReadonlySet<string> = new Set([
  "cloudflare-dns.com",
  "mozilla.cloudflare-dns.com",
  "dns.google"
]);

/** Bluesky's AppView, for the parts of it apps use to find and show accounts. */
export const APPVIEW_HOSTS: ReadonlySet<string> = new Set([
  "public.api.bsky.app",
  "api.bsky.app"
]);

/**
 * Whether an address is the sandbox's, without asking a running sandbox: what an interceptor in another process decides by. A DNS-over-HTTPS lookup counts when the handle it asks about is at a sandbox host.
 */
export const isSandboxAddress = (url: URL): boolean => {
  const handle = dohHandle(url);

  return (
    url.hostname === PLC_HOST ||
    JETSTREAM_HOSTS.has(url.hostname) ||
    APPVIEW_HOSTS.has(url.hostname) ||
    isSandboxHost(url.hostname) ||
    (handle !== undefined && isSandboxHost(handle))
  );
};

/** A request for the DID a handle's own host vouches for: `https://<handle>/.well-known/atproto-did`. */
export const isWellKnownDid = (url: URL): boolean =>
  url.pathname === "/.well-known/atproto-did";

/**
 * Whether a request looks a handle up, at any domain: its well-known DID or its `_atproto` TXT record over DNS-over-HTTPS. An account can hold a real domain as its handle, so an interceptor in another process can't tell from the address alone whether the sandbox answers this one, and asks it.
 */
export const isHandleLookup = (url: URL): boolean =>
  isWellKnownDid(url) || dohHandle(url) !== undefined;

/** The `_atproto` handle a DNS-over-HTTPS query asks about, if that's what it is. */
export const dohHandle = (url: URL): string | undefined => {
  if (
    !DOH_HOSTS.has(url.hostname) ||
    !["/dns-query", "/resolve"].includes(url.pathname)
  ) {
    return undefined;
  }

  const name = (url.searchParams.get("name") ?? "").replace(/\.$/u, "");
  const type = url.searchParams.get("type") ?? "A";

  return name.startsWith("_atproto.") && ["TXT", "16"].includes(type)
    ? name.slice("_atproto.".length)
    : undefined;
};

/** A DNS-over-HTTPS JSON answer, in full as Cloudflare and Google send it (resolvers check the flags): the handle's DID as a TXT record, or no such name. */
export const dohAnswer = (
  handle: string,
  did: string | undefined
): Response => {
  const name = `_atproto.${handle}.`;

  return Response.json(
    {
      Status: did === undefined ? 3 : 0,
      TC: false,
      RD: true,
      RA: true,
      AD: false,
      CD: false,
      Question: [{ name, type: 16 }],
      ...(did !== undefined && {
        Answer: [{ name, type: 16, TTL: 300, data: `"did=${did}"` }]
      })
    },
    { headers: { "content-type": "application/dns-json" } }
  );
};

/** Addresses on this machine. The app under test and the sandbox's control API live here, so an interceptor refusing what Terrarium doesn't own lets these through. */
export const isLoopback = (hostname: string): boolean =>
  hostname === "localhost" ||
  hostname.endsWith(".localhost") ||
  hostname.startsWith("127.") ||
  hostname === "[::1]";

/** What an interceptor does with a request for an address Terrarium doesn't own: let it reach the network, as Mock Service Worker does by default, or refuse it, which proves what's under test never leaves the sandbox. */
export type Unowned = "network" | "refuse";

/** Say on stderr that a request was refused, since the app under test may swallow the failure, and return what was said. */
export const refuse = (url: string | URL): string => {
  const message = `Terrarium refused a request to ${new URL(url).origin}, which it doesn't own.`;

  console.error(message);

  return message;
};

/**
 * Hosts under the reserved `.test` and `.internal` TLDs are always Terrarium's: they can't exist on the public internet, so nothing aimed at the sandbox can leak. Apps mount under either; `.internal` is the one OAuth clients accept for themselves, since atproto's OAuth libraries treat `.test` as a local hostname.
 */
export const isSandboxHost = (hostname: string): boolean =>
  ["test", "internal"].some(
    (tld) => hostname === tld || hostname.endsWith(`.${tld}`)
  );
