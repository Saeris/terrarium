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

/**
 * Hosts under the reserved `.test` and `.internal` TLDs are always Terrarium's: they can't exist on the public internet, so nothing aimed at the sandbox can leak. Apps mount under either; `.internal` is the one OAuth clients accept for themselves, since atproto's OAuth libraries treat `.test` as a local hostname.
 */
export const isSandboxHost = (hostname: string): boolean =>
  ["test", "internal"].some(
    (tld) => hostname === tld || hostname.endsWith(`.${tld}`)
  );
