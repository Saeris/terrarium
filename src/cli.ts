#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { text } from "node:stream/consumers";
import { parseArgs } from "node:util";
import { DEFAULT_CONTROL_PORT, startServer } from "./server";

/**
 * `terrarium`: start a sandbox, then make accounts and seed them from another shell. Every command but `start` talks to the running sandbox's control API and prints JSON, for scripts and agents to read.
 */

const USAGE = `Usage:
  terrarium start [--dir .terrarium] [--host 127.0.0.1] [--port ${String(DEFAULT_CONTROL_PORT)}]
  terrarium accounts                                   List accounts
  terrarium accounts create <name> [--handle <handle>] [--password <password>]
  terrarium seed <name> <file.json | ->                Write records to an account's repo
  terrarium health

Commands other than start reach the sandbox at --url, or TERRARIUM_URL, or http://127.0.0.1:${String(DEFAULT_CONTROL_PORT)}.
Seed files hold [{ "collection", "rkey"?, "record" }], or { "records": [...] }.`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    dir: { type: "string", default: ".terrarium" },
    host: { type: "string", default: "127.0.0.1" },
    port: { type: "string", default: String(DEFAULT_CONTROL_PORT) },
    url: { type: "string" },
    handle: { type: "string" },
    password: { type: "string" },
    help: { type: "boolean", short: "h" }
  }
});

const controlUrl =
  values.url ??
  process.env["TERRARIUM_URL"] ??
  `http://127.0.0.1:${String(DEFAULT_CONTROL_PORT)}`;

const call = async (path: string, init?: RequestInit): Promise<void> => {
  const response = await fetch(`${controlUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json" }
  }).catch((error: unknown) => {
    throw new Error(
      `No sandbox at ${controlUrl} (${String(error)}). Start one with \`terrarium start\`.`,
      { cause: error }
    );
  });
  const text = await response.text();

  if (response.ok) {
    console.log(text);
  } else {
    console.error(text);
    process.exitCode = 1;
  }
};

const [command, ...rest] = positionals;

if (values.help || command === undefined) {
  console.log(USAGE);
} else if (command === "start") {
  const server = await startServer({
    dir: values.dir,
    host: values.host,
    port: Number(values.port)
  });

  console.log(
    JSON.stringify(
      {
        control: server.url,
        plc: server.plcUrl,
        dir: values.dir,
        accounts: server.terrarium.accounts()
      },
      null,
      2
    )
  );

  const stop = async (): Promise<void> => {
    await server.close();
    process.exit(0);
  };

  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
} else if (command === "accounts" && rest[0] === "create" && rest[1]) {
  await call("/accounts", {
    method: "POST",
    body: JSON.stringify({
      name: rest[1],
      ...(values.handle !== undefined && { handle: values.handle }),
      ...(values.password !== undefined && { password: values.password })
    })
  });
} else if (command === "accounts" && rest.length === 0) {
  await call("/accounts");
} else if (command === "seed" && rest[0] && rest[1]) {
  await call(`/accounts/${rest[0]}/records`, {
    method: "POST",
    body:
      rest[1] === "-"
        ? await text(process.stdin)
        : await readFile(rest[1], "utf8")
  });
} else if (command === "health") {
  await call("/health");
} else {
  console.error(USAGE);
  process.exitCode = 1;
}
