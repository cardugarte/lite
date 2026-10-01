import { nwc } from "npm:@getalby/sdk";

export function parseNwcConnectionSecret(connectionSecret: string) {
  const parsed = nwc.NWCClient.parseWalletConnectUrl(connectionSecret);
  if (!parsed.secret) {
    throw new Error("no secret found in connection secret");
  }
  return parsed;
}
