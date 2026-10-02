import { cors } from "hono/cors";
import type { MiddlewareHandler } from "hono/types";

const WRITE_HEADERS = ["Content-Type", "Authorization", "User-Agent"];
// The SDK sends the metadata credential in these headers. Lite never reads their values.
const METADATA_HEADERS = [...WRITE_HEADERS, "X-Breez-Signature", "X-Breez-Timestamp"];
const METHODS = ["GET", "POST", "DELETE", "OPTIONS"];
const METADATA_PATH = /^\/lnurlpay\/[^/]+\/metadata\/?$/;

function corsFor(origins: string[], allowHeaders: string[]): MiddlewareHandler {
  return cors({
    // A function, not the array form: the array form answers an unlisted origin
    // with the first listed one instead of no allow-origin header at all.
    origin: (origin) => (origins.includes(origin) ? origin : null),
    allowMethods: METHODS,
    allowHeaders,
    credentials: false,
    maxAge: 600,
  });
}

/** CORS for `/lnurlpay/*`, limited to the app origins. The metadata route additionally allows the two X-Breez headers. */
export function createLnurlpayCors(origins: string[]): MiddlewareHandler {
  const lnurlpayWriteCors = corsFor(origins, WRITE_HEADERS);
  const lnurlpayMetadataCors = corsFor(origins, METADATA_HEADERS);
  return (c, next) =>
    METADATA_PATH.test(c.req.path) ? lnurlpayMetadataCors(c, next) : lnurlpayWriteCors(c, next);
}
