import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createTerrarium, type Account, type Terrarium } from "../terrarium";
import { startWranglerApp, type WranglerApp } from "../wrangler";

/**
 * A Workers app should get into the sandbox from its Wrangler config alone, configured as `wrangler dev` would configure it, so a project tests what it ships rather than a hand-assembled copy of it.
 */

const CONFIG = fileURLToPath(
  new URL("fixtures/app/wrangler.jsonc", import.meta.url)
);

describe("a Wrangler app in the sandbox", () => {
  let terrarium: Terrarium;
  let alice: Account;
  let app: WranglerApp;

  beforeAll(async () => {
    terrarium = await createTerrarium();
    alice = await terrarium.createAccount({ name: "alice" });
    app = await startWranglerApp(terrarium, {
      config: CONFIG,
      host: "app.example.internal",
      vars: { ORIGIN: "https://app.example.internal" }
    });
  }, 120_000);

  afterAll(async () => {
    await app.dispose();
    await terrarium.dispose();
  });

  it("is configured as wrangler dev configures it, with the sandbox's own overrides on top", async () => {
    const response = await terrarium.fetch(new Request(`${app.url}/env`));

    await expect(response.json()).resolves.toEqual({
      greeting: "from wrangler.jsonc",
      secret: "from .dev.vars",
      origin: "https://app.example.internal"
    });
  });

  it("reaches the sandbox through its own network, at the addresses it already uses", async () => {
    const response = await terrarium.fetch(
      new Request(`${app.url}/?did=${alice.did}`)
    );

    await expect(response.json()).resolves.toEqual({
      pds: "https://alice.terrarium.test"
    });
  });
});
