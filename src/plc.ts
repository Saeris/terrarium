import { readFile, rename, writeFile } from "node:fs/promises";
import * as CBOR from "@atcute/cbor";
import * as CID from "@atcute/cid";
import {
  defs,
  normalizeOp,
  processIndexedEntry,
  validateIncomingOp,
  type IndexedEntryWithSigner
} from "@atcute/did-plc";
import * as v from "valibot";

/**
 * A PLC directory: the same API as `plc.directory`, checking operations the way it does (signatures, the chain of `prev`, the DID derived from the genesis operation), so an identity made here behaves like a real one. Only on this machine, so tests can mint as many as they like without leaving DIDs on the public directory.
 */

export interface Plc {
  fetch(request: Request): Promise<Response>;
}

export interface PlcOptions {
  /** A JSON file to keep the operation logs in. In memory when left out. */
  readonly file?: string;
}

type Log = IndexedEntryWithSigner[];

/** The file: each DID's entries as `log/audit` gives them, plus who signed each, so a reload needn't re-verify them. */
const storedSchema = v.record(
  v.string(),
  v.array(
    v.intersect([
      defs.indexedEntry,
      v.object({
        allowedSigners: v.array(defs.didKeyString),
        signedBy: defs.didKeyString
      })
    ])
  )
);

const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status });

const notFound = (did: string): Response =>
  json({ message: `DID not registered: ${did}` }, 404);

/** The DID document `plc.directory` serves for the latest operation. */
const documentOf = (
  did: string,
  entry: IndexedEntryWithSigner
): Record<string, unknown> | undefined => {
  if (entry.operation.type === "plc_tombstone") {
    return;
  }

  const op = normalizeOp(entry.operation);

  return {
    "@context": [
      "https://www.w3.org/ns/did/v1",
      "https://w3id.org/security/multikey/v1",
      "https://w3id.org/security/suites/secp256k1-2019/v1"
    ],
    id: did,
    alsoKnownAs: op.alsoKnownAs,
    verificationMethod: Object.entries(op.verificationMethods).map(
      ([id, key]) => ({
        id: `${did}#${id}`,
        type: "Multikey",
        controller: did,
        publicKeyMultibase: key.slice("did:key:".length)
      })
    ),
    service: Object.entries(op.services).map(([id, service]) => ({
      id: `#${id}`,
      type: service.type,
      serviceEndpoint: service.endpoint
    }))
  };
};

export const createPlc = async ({ file }: PlcOptions = {}): Promise<Plc> => {
  const logs = new Map<string, Log>(
    file
      ? Object.entries(
          v.parse(
            storedSchema,
            JSON.parse(await readFile(file, "utf8").catch(() => "{}"))
          )
        )
      : []
  );
  let saving: Promise<void> | undefined;

  const write = async (path: string): Promise<void> => {
    await writeFile(`${path}.tmp`, JSON.stringify(Object.fromEntries(logs)));
    await rename(`${path}.tmp`, path);
  };

  /** Written whole and renamed into place, one save at a time, so a crash never leaves half a file. */
  const save = async (): Promise<void> => {
    if (!file) {
      return;
    }

    while (saving) {
      await saving;
    }

    saving = write(file);

    try {
      await saving;
    } finally {
      saving = undefined;
    }
  };

  const submit = async (named: string, body: unknown): Promise<Response> => {
    try {
      const did = v.parse(defs.didPlcString, named);
      const operation = v.parse(defs.compatibleOperationOrTombstone, body);

      validateIncomingOp(operation);

      const canonical = (logs.get(did) ?? []).filter(
        (entry) => !entry.nullified
      );
      const { ops, nullified } = await processIndexedEntry(did, canonical, {
        did,
        operation,
        cid: CID.toString(
          await CID.create(CID.CODEC_DCBOR, CBOR.encode(operation))
        ),
        nullified: false,
        createdAt: new Date().toISOString()
      });

      // `ops` is the whole canonical history; what it displaced stays in the audit log, marked nullified, as on plc.directory.
      logs.set(
        did,
        [
          ...ops,
          ...(logs.get(did) ?? []).filter((entry) => entry.nullified),
          ...nullified.map((entry) => ({ ...entry, nullified: true }))
        ].toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))
      );
      await save();

      return new Response(null, { status: 200 });
    } catch (error) {
      return json(
        { message: error instanceof Error ? error.message : String(error) },
        400
      );
    }
  };

  return {
    async fetch(request) {
      const url = new URL(request.url);

      if (url.pathname === "/_health") {
        return json({ version: "terrarium" });
      }

      const [, encoded = "", ...rest] = url.pathname.split("/");
      const did = decodeURIComponent(encoded);
      const route = rest.join("/");

      if (request.method === "POST" && route === "") {
        return submit(did, await request.json());
      }

      const log = (logs.get(did) ?? []).filter((entry) => !entry.nullified);
      const last = log.at(-1);

      if (request.method !== "GET" || !last) {
        return notFound(did);
      }

      switch (route) {
        case "": {
          const document = documentOf(did, last);

          return document ? json(document) : notFound(did);
        }
        case "data": {
          if (last.operation.type === "plc_tombstone") {
            return notFound(did);
          }

          const { rotationKeys, verificationMethods, alsoKnownAs, services } =
            normalizeOp(last.operation);

          return json({
            did,
            rotationKeys,
            verificationMethods,
            alsoKnownAs,
            services
          });
        }
        case "log": {
          return json(log.map((entry) => entry.operation));
        }
        case "log/last": {
          return json(last.operation);
        }
        case "log/audit": {
          return json(
            (logs.get(did) ?? []).map(
              ({ allowedSigners: _, signedBy: __, ...entry }) => entry
            )
          );
        }
        default: {
          return notFound(did);
        }
      }
    }
  };
};
