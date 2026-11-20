import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import type * as Wrangler from "wrangler";
import { mount, outbound, type OutboundOptions } from "./miniflare";
import type { Terrarium } from "./terrarium";

/**
 * A Cloudflare Workers app inside the sandbox, from its Wrangler config: bundled as `wrangler deploy` bundles it, run under Miniflare with Terrarium as its network, and mounted at a sandbox host, so pages and PDSes reach it there. Its bindings, Durable Objects, assets and `.dev.vars` come from the config, as `wrangler dev` reads them.
 *
 *     const app = await startWranglerApp(terrarium, {
 *       config: "apps/web/wrangler.jsonc",
 *       host: "app.example.internal",
 *       vars: { PUBLIC_ORIGIN: "https://app.example.internal" }
 *     });
 *
 * `.internal` for an app that's an OAuth client: atproto's OAuth libraries won't accept a client at `.test`.
 */

export interface WranglerAppOptions extends OutboundOptions {
  /** The app's `wrangler.jsonc` (or `.json`, `.toml`). */
  readonly config: string;
  /** Where in the sandbox it's served: a `.test` or `.internal` host. */
  readonly host: string;
  /** Variables over the config's and `.dev.vars`', such as the origin the app believes it's served at. */
  readonly vars?: Readonly<Record<string, string>>;
}

export interface WranglerApp {
  /** Where pages and PDSes reach it. */
  readonly url: string;
  readonly miniflare: Miniflare;
  dispose(): Promise<void>;
}

const run = promisify(execFile);

export const startWranglerApp = async (
  terrarium: Terrarium,
  { config, host, vars = {}, unowned = "network" }: WranglerAppOptions
): Promise<WranglerApp> => {
  // Wrangler resolved from the app, so it bundles with the version the app is built with.
  const appRequire = createRequire(resolve(config));
  const wrangler: typeof Wrangler = await import(
    pathToFileURL(appRequire.resolve("wrangler")).href
  );
  const outdir = await mkdtemp(join(tmpdir(), "terrarium-app-"));

  await run(
    process.execPath,
    [
      join(
        dirname(appRequire.resolve("wrangler/package.json")),
        "bin",
        "wrangler.js"
      ),
      "deploy",
      "--dry-run",
      "--config",
      resolve(config),
      "--outdir",
      outdir
    ],
    { cwd: resolve(config, "..") }
  );

  const entry = (await readdir(outdir)).find(
    (file) => file.endsWith(".js") || file.endsWith(".mjs")
  );

  if (entry === undefined) {
    throw new Error(`Wrangler bundled nothing for ${config}.`);
  }

  // Module rules are for building from source; this runs the bundle.
  const {
    workerOptions: { modulesRules: _rules, ...workerOptions }
  } = wrangler.unstable_getMiniflareWorkerOptions(resolve(config));
  const miniflare = new Miniflare(
    convertV4MiniflareOptions({
      ...workerOptions,
      modules: true,
      modulesRoot: outdir,
      scriptPath: join(outdir, entry),
      bindings: Object.fromEntries([
        ...Object.entries(workerOptions.bindings ?? {}),
        ...Object.entries(vars)
      ]),
      outboundService: outbound(terrarium, { unowned })
    })
  );

  await miniflare.ready;

  const unmount = mount(terrarium, host, miniflare);

  return {
    url: `https://${host}`,
    miniflare,
    async dispose() {
      unmount();
      await miniflare.dispose();
      await rm(outdir, { recursive: true, force: true });
    }
  };
};
