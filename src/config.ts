import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import * as v from "valibot";
import type { Plugin, PluginOption } from "vite";
import type { Unowned } from "./hosts";
import type { ServerOptions } from "./server";
import type { Account, SeedRecord } from "./terrarium";

/**
 * What a project says about its sandbox: the accounts it needs, what's in them, and where it runs. Written as the Vite plugin's options (`@saeris/terrarium/vite`) in `vite.config.ts`, where `vite dev` and the CLI's `start` and `run` all read it.
 */

export const PLUGIN_NAME = "terrarium";

export interface AccountConfig {
  /** `<name>.test` by default. Used when the account is made: one that's already there keeps the handle it has. */
  readonly handle?: string;
  readonly password?: string;
  /**
   * Written to its repo, as the account, every time the sandbox starts, so the config is what's there: a record whose rkey is already there is replaced. Each needs an rkey, since one without would be added again every time. A function is given the account, for records that name it, such as an at:// URI with its DID.
   */
  readonly records?:
    | readonly SeedRecord[]
    | ((
        account: Account
      ) => readonly SeedRecord[] | Promise<readonly SeedRecord[]>);
}

export interface TerrariumConfig extends ServerOptions {
  /** Accounts by name, made if they aren't there yet. */
  readonly accounts?: Readonly<Record<string, AccountConfig>>;
  /** What the dev server's requests to addresses the sandbox doesn't own do: `"network"` (the default) or `"refuse"`. */
  readonly unowned?: Unowned;
}

export type TerrariumPlugin = Plugin<{ readonly options: TerrariumConfig }>;

const accountSchema = v.object({
  name: v.string(),
  did: v.string(),
  handle: v.string(),
  endpoint: v.string(),
  local: v.exactOptional(v.string()),
  password: v.string()
});

const call = async (
  url: string,
  path: string,
  body?: unknown
): Promise<Response> =>
  fetch(`${url}${path}`, {
    ...(body !== undefined && {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    })
  });

/** The config's accounts on the sandbox at `url`: each made if it's missing, then given its records. */
export const provision = async (
  url: string,
  accounts: TerrariumConfig["accounts"] = {}
): Promise<Account[]> => {
  const provisioned: Account[] = [];

  // One at a time, so each account gets the same PDS port every time the sandbox is made afresh.
  for (const [name, { records = [], ...account }] of Object.entries(accounts)) {
    const found = await call(url, `/accounts/${name}`);
    const made = found.ok
      ? found
      : await call(url, "/accounts", { name, ...account });

    if (!made.ok) {
      throw new Error(`Terrarium couldn't make ${name}: ${await made.text()}`);
    }

    const ready = v.parse(accountSchema, await made.json());
    const seed = typeof records === "function" ? await records(ready) : records;
    const unkeyed = seed.find(({ rkey }) => rkey === undefined);

    if (unkeyed) {
      throw new Error(
        `${name}'s ${unkeyed.collection} record has no rkey. The config's records are written every time the sandbox starts, replacing the ones already there by rkey, so one without would be added again each time.`
      );
    }

    if (seed.length > 0) {
      const seeded = await call(url, `/accounts/${name}/records`, seed);

      if (!seeded.ok) {
        throw new Error(
          `Terrarium refused ${name}'s records: ${await seeded.text()}`
        );
      }
    }

    provisioned.push(ready);
  }

  return provisioned;
};

const flatten = async (options: readonly PluginOption[]): Promise<Plugin[]> => {
  const plugins: Plugin[] = [];

  for (const pending of options) {
    const option = await pending;

    if (Array.isArray(option)) {
      plugins.push(...(await flatten(option)));
    } else if (option) {
      plugins.push(option);
    }
  }

  return plugins;
};

/**
 * The Terrarium plugin's options in a Vite config: the file given, or the one Vite would find in `root`. Undefined when there's no config, or no Terrarium in it. A relative `dir` is the config's directory's, as it is for `vite dev`.
 */
export const loadConfig = async (
  file?: string,
  root = process.cwd()
): Promise<TerrariumConfig | undefined> => {
  // Vite is needed only to read a Vite config: without one, it may not be installed at all.
  if (
    file === undefined &&
    !readdirSync(root).some((name) => /^vite\.config\.[cm]?[jt]s$/u.test(name))
  ) {
    return undefined;
  }

  const { loadConfigFromFile } = await import("vite");
  const loaded = await loadConfigFromFile(
    { command: "serve", mode: "development" },
    file,
    root,
    "silent"
  );
  const plugin = (await flatten(loaded?.config.plugins ?? [])).find(
    (candidate): candidate is TerrariumPlugin => candidate.name === PLUGIN_NAME
  );

  if (!loaded || !plugin?.api) {
    return undefined;
  }

  const { options } = plugin.api;

  return {
    ...options,
    ...(options.dir !== undefined && {
      dir: resolve(dirname(loaded.path), options.dir)
    })
  };
};
