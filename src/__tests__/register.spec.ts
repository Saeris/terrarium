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

describe("terrarium in another process", () => {
  let server: Server;
  let alice: Account;
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
    await server.terrarium.seed("alice", [
      { collection: NOTE, rkey: "hello", record: { text: "hello, process" } }
    ]);
    await writeFile(join(dir, "app.mjs"), APP);
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
});
