import {
  deriveDidFromGenesisOp,
  signOperation,
  type Operation,
  type UnsignedOperation
} from "@atcute/did-plc";
import * as CBOR from "@atcute/cbor";
import * as CID from "@atcute/cid";
import { describe, expect, it } from "vite-plus/test";
import { keyFrom, newKey } from "../keys";
import { createPlc } from "../plc";

/**
 * Terrarium's PLC directory has to hold identities to the same rules `plc.directory` does. If it accepted anything, a test of what happens when an identity changes, or of who may change it, would prove nothing.
 */

const URL_BASE = "http://plc.test";

const post = (did: string, op: unknown): Request =>
  new Request(`${URL_BASE}/${did}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(op)
  });

const cidOf = async (op: Operation): Promise<string> =>
  CID.toString(await CID.create(CID.CODEC_DCBOR, CBOR.encode(op)));

const identity = async (): Promise<{
  did: string;
  genesis: Operation;
  rotationKey: string;
  unsigned: UnsignedOperation;
}> => {
  const rotationKey = await newKey();
  const unsigned: UnsignedOperation = {
    type: "plc_operation",
    prev: null,
    alsoKnownAs: ["at://alice.test"],
    rotationKeys: [await (await keyFrom(rotationKey)).exportPublicKey("did")],
    verificationMethods: {
      atproto: await (await keyFrom(await newKey())).exportPublicKey("did")
    },
    services: {
      atproto_pds: {
        type: "AtprotoPersonalDataServer",
        endpoint: "http://pds.alice.test"
      }
    }
  };
  const genesis = await signOperation(unsigned, await keyFrom(rotationKey));

  return {
    did: await deriveDidFromGenesisOp(genesis),
    genesis,
    rotationKey,
    unsigned
  };
};

describe("terrarium's PLC directory", () => {
  it("registers a DID and serves its document, as plc.directory does", async () => {
    const plc = await createPlc();
    const { did, genesis } = await identity();

    expect((await plc.fetch(post(did, genesis))).status).toBe(200);

    const document = await (
      await plc.fetch(new Request(`${URL_BASE}/${did}`))
    ).json();

    expect(document).toMatchObject({
      id: did,
      alsoKnownAs: ["at://alice.test"],
      service: [
        {
          id: "#atproto_pds",
          type: "AtprotoPersonalDataServer",
          serviceEndpoint: "http://pds.alice.test"
        }
      ]
    });
  });

  it("refuses a genesis operation filed under a DID it doesn't hash to", async () => {
    const plc = await createPlc();
    const { genesis } = await identity();
    const other = await identity();

    expect((await plc.fetch(post(other.did, genesis))).status).toBe(400);
  });

  it("lets the rotation key change the identity, and nobody else", async () => {
    const plc = await createPlc();
    const { did, genesis, rotationKey, unsigned } = await identity();

    await plc.fetch(post(did, genesis));

    const moved = {
      ...unsigned,
      prev: await cidOf(genesis),
      alsoKnownAs: ["at://alice-renamed.test"]
    };
    const forged = await signOperation(moved, await keyFrom(await newKey()));

    expect((await plc.fetch(post(did, forged))).status).toBe(400);
    expect(
      (
        await plc.fetch(
          post(did, await signOperation(moved, await keyFrom(rotationKey)))
        )
      ).status
    ).toBe(200);
    await expect(
      (await plc.fetch(new Request(`${URL_BASE}/${did}`))).json()
    ).resolves.toMatchObject({ alsoKnownAs: ["at://alice-renamed.test"] });
  });

  it("knows nothing about a DID it never registered", async () => {
    const plc = await createPlc();

    expect(
      (await plc.fetch(new Request(`${URL_BASE}/did:plc:nobodyhere`))).status
    ).toBe(404);
  });
});
