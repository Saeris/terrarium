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

const app = command(
  name("terrarium"),
  description(
    "An Atmosphere in a box: a PLC directory and a PDS per account, on this machine."
  ),
  version(manifest.version),
  command(
    name("start"),
    description("Start a sandbox and keep it running"),
    option(
      name("dir"),
      description("Where to keep accounts and data"),
      schema(v.optional(v.string(), ".terrarium"))
    ),
    option(
      name("host"),
      description("The host every service is addressed by"),
      schema(v.optional(v.string(), DEFAULT_HOST))
    ),
    option(
      name("port"),
      description("The control API's port"),
      schema(v.optional(v.number(), DEFAULT_CONTROL_PORT))
    )
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
        description("Its handle (default <name>.test)"),
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

const start = async ({
  dir,
  host,
  port
}: {
  dir: string;
  host: string;
  port: number;
}): Promise<void> => {
  // A person at a terminal gets a summary; a script or an agent gets one line of JSON to read.
  const human = process.stdout.isTTY;
  const progress = human ? spinner() : undefined;

  if (human) {
    intro("terrarium");
  }

  progress?.start(`Starting the sandbox in ${dir}`);

  const server = await startServer({ dir, host, port });
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
