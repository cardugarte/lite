export const BREEZ_SDK_SPARK_DENO_SPECIFIER =
  "npm:@breeztech/breez-sdk-spark@0.25.0/deno/breez_sdk_spark_wasm.js";

/** A webhook subscription as `listWebhooks()` reports it (SDK 0.25.0 `Webhook`). */
export type SparkWebhook = {
  id: string;
  url: string;
  eventTypes: Array<{ type: string }>;
};

export type SparkMinter = {
  connect?(): Promise<void>;
  createInvoice(input: {
    receiverIdentityPubkey: string;
    amountSats: number;
    memo: string;
  }): Promise<{
    invoice: string;
    paymentHash: string;
    /** The receiver key the invoice was minted for, so the mint can record it. */
    receiverPubkey: string;
  }>;
};
