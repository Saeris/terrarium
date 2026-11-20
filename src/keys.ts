import { Secp256k1PrivateKeyExportable } from "@atcute/crypto";

/**
 * Keys as Terrarium stores them: secp256k1, hex-encoded, which is what Cirrus takes as its signing key. Kept in the sandbox's state so an account keeps its identity across restarts.
 */

/** A new secp256k1 private key, hex-encoded. */
export const newKey = async (): Promise<string> =>
  (await Secp256k1PrivateKeyExportable.createKeypair()).exportPrivateKey(
    "rawHex"
  );

/** A stored key, ready to sign with or to name as a `did:key`. */
export const keyFrom = async (
  hex: string
): Promise<Secp256k1PrivateKeyExportable> =>
  Secp256k1PrivateKeyExportable.importRaw(Buffer.from(hex, "hex"));
