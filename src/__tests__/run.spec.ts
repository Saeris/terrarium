import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { run } from "../run";
import { startServer, type Server } from "../server";

/**
 * `terrarium run` is how an app's dev server or test runner gets the sandbox without a second shell: the command is told where the sandbox is and preloaded to reach it at the network's own addresses. A sandbox started for the command must not outlive it, and one already running must not be taken down by it.
 */

const REGISTER = new URL("../../dist/register.mjs", import.meta.url);
const NOTE = "dev.terrarium.test.note";

/** An app that knows nothing about Terrarium: it makes an account through the control API if asked, then reads it at plc.directory and on the PDS its DID document names, and writes what it found to a file. */
const APP = `
import { writeFile } from "node:fs/promises";
const [out, given, code] = process.argv.slice(2);
const did = given === "-"
  ? (await (await fetch(process.env.TERRARIUM_URL + "/accounts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "carol" }) })).json()).did
  : given;
const document = await (await fetch("https://plc.directory/" + did)).json();
const pds = document.service[0].serviceEndpoint;
const repo = await (await fetch(pds + "/xrpc/com.atproto.repo.describeRepo?repo=" + did)).json();
const notes = await (await fetch(pds + "/xrpc/com.atproto.repo.listRecords?repo=" + did + "&collection=${NOTE}")).json();
await writeFile(out, JSON.stringify({ control: process.env.TERRARIUM_URL, pds, handle: repo.handle, notes: notes.records.map((record) => record.value.text) }));
process.exit(Number(code));
`;

interface Found {
  control: string;
  pds: string;
  handle: string;
  notes: string[];
}

const isUp = async (url: string): Promise<boolean> => {
  try {
    return (await fetch(`${url}/health`)).ok;
  } catch {
    return false;
  }
};

describe("terrarium run", () => {
  let dir: string;
  let app: string;

  beforeAll(async () => {
    if (!existsSync(REGISTER)) {
      throw new Error(
        `${REGISTER.href} is missing: build with \`vp pack\` before testing the preload.`
      );
    }

    dir = await mkdtemp(join(tmpdir(), "terrarium-run-"));
    app = join(dir, "app.mjs");
    await writeFile(app, APP);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("starts a sandbox for the command, which reaches it unmodified, then stops it and exits as the command did", async () => {
    const out = join(dir, "started.json");
    const url = "http://127.0.0.1:25900";

    const code = await run({
      command: `node "${app}" "${out}" - 3`,
      url,
      register: REGISTER,
      dir: join(dir, "state"),
      port: 25_900,
      ports: { plc: 25_920, jetstream: 25_940, pds: 26_100 }
    });
    const found = JSON.parse(await readFile(out, "utf8")) as Found;

    expect(code).toBe(3);
    expect(found).toMatchObject({
      control: url,
      pds: "https://carol.terrarium.test",
      handle: "carol.test"
    });
    // Nothing left behind: the next run starts afresh, from the same directory.
    await expect(isUp(url)).resolves.toBe(false);
  }, 60_000);

  describe("with a sandbox already running", () => {
    let server: Server;

    beforeAll(async () => {
      server = await startServer({
        port: 25_950,
        ports: { plc: 25_960, jetstream: 25_970, pds: 26_200 }
      });
      await server.terrarium.createAccount({ name: "alice" });
      await server.terrarium.seed("alice", [
        { collection: NOTE, record: { text: "already here" } }
      ]);
    }, 60_000);

    afterAll(async () => {
      await server.close();
    });

    it("uses it, and leaves it running for whatever else uses it", async () => {
      const out = join(dir, "running.json");
      const alice = server.terrarium.account("alice");

      const code = await run({
        command: `node "${app}" "${out}" ${alice?.did ?? ""} 0`,
        url: server.url,
        register: REGISTER
      });
      const found = JSON.parse(await readFile(out, "utf8")) as Found;

      expect(code).toBe(0);
      expect(found).toMatchObject({
        control: server.url,
        handle: "alice.test",
        notes: ["already here"]
      });
      await expect(isUp(server.url)).resolves.toBe(true);
    });
  });
});
