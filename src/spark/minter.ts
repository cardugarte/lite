export const BREEZ_SDK_SPARK_DENO_SPECIFIER =
  "npm:@breeztech/breez-sdk-spark@0.25.0/deno/breez_sdk_spark_wasm.js";

export type SparkMinter = {
  createInvoice(input: {
    receiverIdentityPubkey: string;
    amountSats: number;
    memo: string;
  }): Promise<{ invoice: string; paymentHash: string }>;
};
