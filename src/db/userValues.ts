import { nwc } from "npm:@getalby/sdk";

export type SparkUserValues = {
  encryptedConnectionSecret: null;
  destination: "spark";
  sparkIdentityPubkey: string;
  username: string;
  nostrPubkey: string;
};

export function parseNwcConnectionSecret(connectionSecret: string) {
  const parsed = nwc.NWCClient.parseWalletConnectUrl(connectionSecret);
  if (!parsed.secret) {
    throw new Error("no secret found in connection secret");
  }
  return parsed;
}

const COMPRESSED_SECP256K1_HEX = /^0[23][0-9a-fA-F]{64}$/;

export function buildSparkUserValues(input: {
  sparkIdentityPubkey: string;
  username?: string;
  nostrPubkey?: string;
}): SparkUserValues {
  if (!input.sparkIdentityPubkey) {
    throw new Error("no spark identity pubkey provided");
  }
  const sparkIdentityPubkey = input.sparkIdentityPubkey.trim();
  if (!COMPRESSED_SECP256K1_HEX.test(sparkIdentityPubkey)) {
    throw new Error(
      "Spark identity pubkey must be a 33-byte compressed secp256k1 key (66 hex chars starting with 02 or 03)",
    );
  }
  return {
    encryptedConnectionSecret: null,
    destination: "spark",
    sparkIdentityPubkey: sparkIdentityPubkey.toLowerCase(),
    username: input.username || Math.floor(Math.random() * 100000000000).toString(),
    nostrPubkey: input.nostrPubkey || "",
  };
}
