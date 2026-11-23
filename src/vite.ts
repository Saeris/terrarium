import { resolve } from "node:path";
import {
  PLUGIN_NAME,
  provision,
  type TerrariumConfig,
  type TerrariumPlugin
} from "./config";
import type { Interception } from "./intercept";
import type { Server } from "./server";

export type { AccountConfig, TerrariumConfig, TerrariumPlugin } from "./config";

/**
 * Terrarium as a Vite plugin: `vite dev` brings the sandbox up with the accounts and records its options name, and points the dev server's own process at it, so the app's server code (SSR, API routes, server functions) reaches it at the network's own addresses. A sandbox already running is used and left running; one the dev server started stops with it. The CLI's `start` and `run` read the same options from `vite.config.ts`.
 *
 *     export default defineConfig({
 *       plugins: [
 *         terrarium({
 *           accounts: {
 *             alice: {},
 *             venue: { handle: "venue.example.com", records: (venue) => menu(venue.did) }
 *           }
 *         })
 *       ]
 *     });
 *
 * It stays out of `vite build`, `vite preview` and the server Vitest makes to run tests.
 */

interface Sandbox {
  readonly url: string;
  readonly started: Server | undefined;
  readonly interception: Interception;
}

// On a restart, Vite makes the new server before closing the old one, so the sandbox lives beside the servers rather than in one.
let current: Promise<Sandbox> | undefined;

const open = async (
  {
    accounts: _,
    unowned = "network",
    dir = ".terrarium",
    ...options
  }: TerrariumConfig,
  root: string
): Promise<Sandbox> => {
  // Loaded only now: a build reads this plugin too, and needs none of it.
  const [
    { DEFAULT_CONTROL_PORT, isRunning, startServer },
    { DEFAULT_HOST },
    { intercept }
  ] = await Promise.all([
    import("./server"),
    import("./terrarium"),
    import("./intercept")
  ]);
  const url =
    process.env["TERRARIUM_URL"] ??
    `http://${options.host ?? DEFAULT_HOST}:${String(options.port ?? DEFAULT_CONTROL_PORT)}`;
  const started = (await isRunning(url))
    ? undefined
    : await startServer({ ...options, dir: resolve(root, dir) });
  const control = started?.url ?? url;

  try {
    return {
      url: control,
      started,
      interception: await intercept({ control, unowned })
    };
  } catch (error) {
    await started?.close();
    throw error;
  }
};

export const terrarium = (options: TerrariumConfig = {}): TerrariumPlugin => ({
  name: PLUGIN_NAME,
  apply: (_, { command }) =>
    command === "serve" && process.env["VITEST"] === undefined,
  api: { options },
  async configureServer(server) {
    current ??= open(options, server.config.root);

    let sandbox: Sandbox;

    try {
      sandbox = await current;
    } catch (error) {
      current = undefined;
      throw error;
    }

    // Every time, a restart included: the config may have changed.
    const accounts = await provision(sandbox.url, options.accounts);

    server.config.logger.info(
      `terrarium: ${sandbox.started ? "started a sandbox" : "using the sandbox"} at ${sandbox.url}${accounts.length > 0 ? `, with ${accounts.map(({ handle }) => handle).join(", ")}` : ""}`,
      { timestamp: true }
    );
  },
  async closeServer({ reason }) {
    // A restart's new server is already using the sandbox.
    if (reason === "restart" || current === undefined) {
      return;
    }

    const closing = current;

    current = undefined;

    const { started, interception } = await closing;

    interception.close();
    await started?.close();
  }
});
