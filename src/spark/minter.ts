/**
 * The package's exported Node entry. The `./deno` entry has no default
 * storage (the compiled binary crashes at connect) and deep wasm paths are
 * not exported.
 */
export const BREEZ_SDK_SPARK_NODE_SPECIFIER =
  "npm:@breeztech/breez-sdk-spark@0.25.0/nodejs";

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
    /** Seconds until the invoice expires. Left out, the SDK mints 30-day invoices. */
    expirySecs: number;
  }): Promise<{
    invoice: string;
    paymentHash: string;
    /** The receiver key the invoice was minted for, so the mint can record it. */
    receiverPubkey: string;
  }>;
};
