import { nwc } from "npm:@getalby/sdk";

export const SPARK_PUBKEY_REGEX = /^0[23][0-9a-f]{64}$/;

export function parseNwcConnectionSecret(connectionSecret: string) {
  const parsed = nwc.NWCClient.parseWalletConnectUrl(connectionSecret);
  if (!parsed.secret) {
    throw new Error("no secret found in connection secret");
  }
  return parsed;
}
