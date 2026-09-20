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

export function buildSparkUserValues(input: {
  sparkIdentityPubkey: string;
  username?: string;
  nostrPubkey?: string;
}): SparkUserValues {
  if (!input.sparkIdentityPubkey) {
    throw new Error("no spark identity pubkey provided");
  }
  return {
    encryptedConnectionSecret: null,
    destination: "spark",
    sparkIdentityPubkey: input.sparkIdentityPubkey,
    username: input.username || Math.floor(Math.random() * 100000000000).toString(),
    nostrPubkey: input.nostrPubkey || "",
  };
}
