import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { startServer, type Server } from "../server";
import type { Account } from "../terrarium";

/**
 * An app's dev server is its own process, out of reach of anything a test sets up in its own. Preloaded with `@saeris/terrarium/register`, that process reaches a running sandbox at the network's own addresses, as code under Mock Service Worker does, without one line of its configuration changing.
 */

const REGISTER = fileURLToPath(
  new URL("../../dist/register.mjs", import.meta.url)
);
const NOTE = "dev.terrarium.test.note";

/** An app that knows nothing about Terrarium: it reads an account, then follows it on Jetstream, and says what it found. */
const APP = `
const did = process.argv[2];
const document = await (await fetch("https://plc.directory/" + did)).json();
const pds = document.service[0].serviceEndpoint;
const record = await (await fetch(pds + "/xrpc/com.atproto.repo.getRecord?repo=" + did + "&collection=${NOTE}&rkey=hello")).json();
console.log(JSON.stringify({ pds, text: record.value.text }));
const socket = new WebSocket("wss://jetstream2.us-east.bsky.network/subscribe?wantedDids=" + did);
socket.addEventListener("open", () => console.log(JSON.stringify({ listening: true })));
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (message.commit?.record?.text === "heard by the app") {
    console.log(JSON.stringify({ heard: message.commit.record.text }));
    process.exit(0);
  }
});
`;

/** An app reaching for the internet, and for this machine, to see which get through. */
const ELSEWHERE = `
const http = await fetch("https://example.com/").then((response) => response.status);
const local = await fetch(process.env.TERRARIUM_URL + "/health").then((response) => response.status);
const socket = await new Promise((resolve) => {
  const connection = new WebSocket("wss://example.com/");
  connection.addEventListener("open", () => resolve("open"));
  connection.addEventListener("error", () => resolve("error"));
});
const held = await fetch("https://example.com/.well-known/atproto-did").then((response) => response.text());
const unheld = await fetch("https://example.org/.well-known/atproto-did").then((response) => response.status);
console.log(JSON.stringify({ http, local, socket, held, unheld }));
`;

const run = async (
  script: string,
  args: string[],
  env: Record<string, string>
): Promise<{ stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", pathToFileURL(REGISTER).href, script, ...args],
      { env: { ...process.env, ...env } }
    );
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", () => {
      resolve({ stdout, stderr });
    });
  });

describe("terrarium in another process", () => {
  let server: Server;
  let alice: Account;
  let site: Account;
  let dir: string;

  beforeAll(async () => {
    if (!existsSync(REGISTER)) {
      throw new Error(
        `${REGISTER} is missing: build with \`vp pack\` before testing the preload.`
      );
    }

    dir = await mkdtemp(join(tmpdir(), "terrarium-register-"));
    server = await startServer({
      port: 25_800,
      ports: { plc: 25_820, jetstream: 25_840, pds: 26_000 }
    });
    alice = await server.terrarium.createAccount({ name: "alice" });
    site = await server.terrarium.createAccount({
      name: "site",
      handle: "example.com"
    });
    await server.terrarium.seed("alice", [
      { collection: NOTE, rkey: "hello", record: { text: "hello, process" } }
    ]);
    await writeFile(join(dir, "app.mjs"), APP);
    await writeFile(join(dir, "elsewhere.mjs"), ELSEWHERE);
  }, 60_000);

  afterAll(async () => {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("reads the sandbox and follows its Jetstream from an unmodified app", async () => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        pathToFileURL(REGISTER).href,
        join(dir, "app.mjs"),
        alice.did
      ],
      { env: { ...process.env, TERRARIUM_URL: server.url } }
    );
    const lines = createInterface({ input: child.stdout });
    const said: unknown[] = [];
    let stderr = "";

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    for await (const line of lines) {
      const message = JSON.parse(line) as Record<string, unknown>;

      said.push(message);

      if (message["listening"] === true) {
        await server.terrarium.seed("alice", [
          { collection: NOTE, record: { text: "heard by the app" } }
        ]);
      }
    }

    expect(stderr).toBe("");
    expect(said).toEqual([
      { pds: "https://alice.terrarium.test", text: "hello, process" },
      { listening: true },
      { heard: "heard by the app" }
    ]);
  }, 60_000);

  it("keeps the process off the internet when asked, saying what it refused, but not off this machine", async () => {
    const { stdout, stderr } = await run(join(dir, "elsewhere.mjs"), [], {
      TERRARIUM_URL: server.url,
      TERRARIUM_UNOWNED: "refuse"
    });

    // example.com is held by a sandbox account as its handle, so its handle lookup is answered even though the rest of the domain is refused; example.org's isn't anyone's.
    expect(JSON.parse(stdout)).toEqual({
      http: 502,
      local: 200,
      socket: "error",
      held: site.did,
      unheld: 502
    });
    expect(stderr).toContain(
      "Terrarium refused a request to https://example.com"
    );
    expect(stderr).toContain(
      "Terrarium refused a request to wss://example.com"
    );
    expect(stderr).toContain(
      "Terrarium refused a request to https://example.org"
    );
  }, 60_000);
});
