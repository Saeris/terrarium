#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { text } from "node:stream/consumers";
import {
  argument,
  command,
  description,
  env,
  name,
  option,
  parse,
  printErrors,
  printHelp,
  printVersion,
  schema,
  version
} from "@bomb.sh/router";
import { intro, log, outro, spinner } from "@clack/prompts";
import * as v from "valibot";
import manifest from "../package.json" with { type: "json" };
import { loadConfig, provision, type TerrariumConfig } from "./config";
import { run } from "./run";
import { DEFAULT_CONTROL_PORT, startServer } from "./server";
import { DEFAULT_HOST } from "./terrarium";

/**
 * `terrarium`: start a sandbox, then make accounts and seed them from another shell. Every command but `start` talks to the running sandbox's control API and prints JSON, for scripts and agents to read.
 */

const DEFAULT_URL = `http://${DEFAULT_HOST}:${String(DEFAULT_CONTROL_PORT)}`;

const url = option(
  name("url"),
  description(`Where the sandbox's control API is (default ${DEFAULT_URL})`),
  schema(v.optional(v.string(), DEFAULT_URL)),
  env("TERRARIUM_URL")
);

// Left unset unless given, so a Vite config's Terrarium options can fill them.
const dir = option(
  name("dir"),
  description("Where to keep accounts and data (default .terrarium)"),
  schema(v.optional(v.string()))
);

const host = option(
  name("host"),
  description(
    `The host every service is addressed by (default ${DEFAULT_HOST})`
  ),
  schema(v.optional(v.string()))
);

const port = option(
  name("port"),
  description(
    `The control API's port (default ${String(DEFAULT_CONTROL_PORT)})`
  ),
  schema(v.optional(v.number()))
);

const config = option(
  name("config"),
  description(
    "A Vite config whose Terrarium plugin names the accounts to make, and where the sandbox runs (default vite.config.* here, if there is one)"
  ),
  schema(v.optional(v.string()))
);

const app = command(
  name("terrarium"),
  description(
    "An Atmosphere in a box: a PLC directory and a PDS per account, on this machine."
  ),
  version(manifest.version),
  command(
    name("start"),
    description("Start a sandbox and keep it running"),
    config,
    dir,
    host,
    port
  ),
  command(
    name("run"),
    description(
      'Run a command inside the sandbox, such as "yarn dev": its Node processes reach the sandbox at the network\'s addresses. Uses the sandbox at --url, or starts one for the command and stops it after'
    ),
    argument(name("command"), schema(v.string())),
    option(
      name("unowned"),
      description(
        'What the command\'s requests to anywhere else do: "network" (the default) or "refuse"'
      ),
      schema(v.optional(v.picklist(["network", "refuse"])))
    ),
    option(
      name("url"),
      description(
        "Where a running sandbox's control API would be (default the --host and --port it would start on)"
      ),
      schema(v.optional(v.string())),
      env("TERRARIUM_URL")
    ),
    config,
    dir,
    host,
    port
  ),
  command(
    name("accounts"),
    description("List accounts: DIDs, handles, PDS URLs and passwords"),
    url,
    command(
      name("create"),
      description("Make an account, on its own PDS"),
      argument(name("name"), schema(v.string())),
      option(
        name("handle"),
        description(
          "Its handle (default <name>.test); a real domain works, and only its handle lookups are answered"
        ),
        schema(v.optional(v.string()))
      ),
      option(
        name("password"),
        description('Its password (default "password")'),
        schema(v.optional(v.string()))
      ),
      url
    )
  ),
  command(
    name("seed"),
    description(
      'Write records to an account\'s repo, from a JSON file or "-" for stdin: [{ collection, rkey?, record }]'
    ),
    argument(name("name"), schema(v.string())),
    argument(name("file"), schema(v.string())),
    url
  ),
  command(
    name("jetstream"),
    description("Whether Jetstream is paused, and which accounts it ignores"),
    url,
    command(
      name("pause"),
      description(
        "Hold every event back, as a relay that has fallen behind does"
      ),
      url
    ),
    command(name("resume"), description("Deliver what was held back"), url),
    command(
      name("ignore"),
      description(
        "Stop carrying an account's events, as a relay that drops its PDS does"
      ),
      argument(name("name"), schema(v.string())),
      url
    ),
    command(
      name("heed"),
      description("Carry an ignored account's events again"),
      argument(name("name"), schema(v.string())),
      url
    )
  ),
  command(name("health"), description("Check the sandbox is up"), url)
);

const call = async (
  base: string,
  path: string,
  init?: RequestInit
): Promise<void> => {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { "content-type": "application/json" }
  }).catch((error: unknown) => {
    throw new Error(
      `No sandbox at ${base} (${String(error)}). Start one with \`terrarium start\`.`,
      { cause: error }
    );
  });
  const body = await response.text();

  if (response.ok) {
    console.log(body);
  } else {
    console.error(body);
    process.exitCode = 1;
  }
};

interface Flags {
  readonly config?: string | undefined;
  readonly dir?: string | undefined;
  readonly host?: string | undefined;
  readonly port?: number | undefined;
}

/** The sandbox's settings: the flags given, then the Vite config's Terrarium options, then the defaults. */
const configure = async ({
  config: file,
  dir,
  host,
  port
}: Flags): Promise<
  TerrariumConfig & { dir: string; host: string; port: number }
> => {
  const found = await loadConfig(file);

  return {
    ...found,
    dir: dir ?? found?.dir ?? ".terrarium",
    host: host ?? found?.host ?? DEFAULT_HOST,
    port: port ?? found?.port ?? DEFAULT_CONTROL_PORT
  };
};

const start = async (flags: Flags): Promise<void> => {
  const { accounts: wanted, unowned: _, ...options } = await configure(flags);
  const { dir } = options;
  // A person at a terminal gets a summary; a script or an agent gets one line of JSON to read.
  const human = process.stdout.isTTY;
  const progress = human ? spinner() : undefined;

  if (human) {
    intro("terrarium");
  }

  progress?.start(`Starting the sandbox in ${dir}`);

  const server = await startServer(options);

  try {
    await provision(server.url, wanted);
  } catch (error) {
    await server.close();
    throw error;
  }

  const accounts = server.terrarium.accounts();

  if (human) {
    progress?.stop(`Sandbox running, ${String(accounts.length)} accounts`);
    log.info(
      `Control API  ${server.url}\nPLC          ${server.terrarium.plcUrl}  (local: ${server.plcUrl})\nJetstream    ${server.terrarium.jetstreamUrl}  (local: ${server.jetstreamUrl})`
    );

    for (const account of accounts) {
      log.step(
        `${account.handle}  ${account.endpoint}  (local: ${account.local ?? "none"})  ${account.did}`
      );
    }

    outro("Ctrl+C to stop");
  } else {
    console.log(
      JSON.stringify({
        control: server.url,
        plc: server.terrarium.plcUrl,
        jetstream: server.terrarium.jetstreamUrl,
        local: { plc: server.plcUrl, jetstream: server.jetstreamUrl },
        dir,
        accounts
      })
    );
  }

  const stop = async (): Promise<void> => {
    await server.close();
    process.exit(0);
  };

  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
};

const result = parse(app, {
  argv: process.argv.slice(2),
  envs: [{ name: "process", value: process.env }]
});

if (!result.ok) {
  console.error(printErrors(result));
  process.exitCode = 1;
} else if (result.method === "help") {
  console.log(printHelp(result));
} else if (result.method === "version") {
  console.log(printVersion(result));
} else {
  switch (result.route) {
    case "/": {
      console.log(printHelp({ ...result, method: "help" }));
      break;
    }
    case "/start": {
      await start(result.model);
      break;
    }
    case "/run": {
      const { command, url: running, unowned } = result.model;
      const settings = await configure(result.model);

      process.exitCode = await run({
        ...settings,
        command,
        url: running ?? `http://${settings.host}:${String(settings.port)}`,
        ...(unowned !== undefined && { unowned })
      });
      break;
    }
    case "/accounts": {
      await call(result.model.url, "/accounts");
      break;
    }
    case "/accounts/create": {
      const { url: base, ...account } = result.model;

      await call(base, "/accounts", {
        method: "POST",
        body: JSON.stringify(account)
      });
      break;
    }
    case "/seed": {
      const { url: base, name: account, file } = result.model;

      await call(base, `/accounts/${account}/records`, {
        method: "POST",
        body:
          file === "-"
            ? await text(process.stdin)
            : await readFile(file, "utf8")
      });
      break;
    }
    case "/jetstream": {
      await call(result.model.url, "/jetstream");
      break;
    }
    case "/jetstream/pause":
    case "/jetstream/resume": {
      await call(result.model.url, result.route, { method: "POST" });
      break;
    }
    case "/jetstream/ignore":
    case "/jetstream/heed": {
      await call(result.model.url, `${result.route}/${result.model.name}`, {
        method: "POST"
      });
      break;
    }
    case "/health": {
      await call(result.model.url, "/health");
      break;
    }
  }
}
