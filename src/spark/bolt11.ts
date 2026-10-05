const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

/** The timestamp opens the data part: 7 groups of 5 bits. */
const TIMESTAMP_GROUPS = 7;
/** The 520-bit signature and recovery id that close every invoice: 104 groups. */
const SIGNATURE_GROUPS = 104;
/** Tagged field types: the bech32 character at this index (`p` is 1, `x` is 6). */
const TAG_PAYMENT_HASH = 1;
const TAG_EXPIRY = 6;
/** BOLT11: an invoice without an `x` field expires one hour after its timestamp. */
const DEFAULT_EXPIRY_SECS = 3600;

function bech32Values(invoice: string): number[] {
  const lower = invoice.toLowerCase();
  const pos = lower.lastIndexOf("1");
  if (pos < 1) throw new Error("invalid bolt11");
  const data = lower.slice(pos + 1);
  const values: number[] = [];
  for (const c of data) {
    const v = CHARSET.indexOf(c);
    if (v === -1) throw new Error("invalid bolt11");
    values.push(v);
  }
  if (values.length < 13) throw new Error("invalid bolt11");
  return values.slice(0, -6);
}

function convertBits(data: number[], from: number, to: number, pad: boolean): number[] {
  let acc = 0;
  let bits = 0;
  const ret: number[] = [];
  const maxv = (1 << to) - 1;
  for (const value of data) {
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      ret.push((acc >> bits) & maxv);
    }
  }
  if (pad && bits > 0) ret.push((acc << (to - bits)) & maxv);
  return ret;
}

/** Big-endian 5-bit groups as an integer. Multiplies rather than shifts: a timestamp needs 35 bits. */
function groupsToInt(groups: number[]): number {
  return groups.reduce((total, group) => total * 32 + group, 0);
}

/**
 * The timestamp and the tagged fields of an invoice. The checksum and the
 * signature are not verified: Lite reads invoices it asked a wallet to mint.
 * The signature groups are excluded, so they are never read as fields.
 */
function parseInvoice(invoice: string): { timestamp: number; fields: Array<{ type: number; data: number[] }> } {
  const values = bech32Values(invoice);
  if (values.length < TIMESTAMP_GROUPS + SIGNATURE_GROUPS) throw new Error("invalid bolt11");
  const end = values.length - SIGNATURE_GROUPS;
  const fields: Array<{ type: number; data: number[] }> = [];
  let i = TIMESTAMP_GROUPS;
  while (i + 3 <= end) {
    const type = values[i];
    const dataLength = (values[i + 1] << 5) | values[i + 2];
    i += 3;
    fields.push({ type, data: values.slice(i, i + dataLength) });
    i += dataLength;
  }
  return { timestamp: groupsToInt(values.slice(0, TIMESTAMP_GROUPS)), fields };
}

export function paymentHashFromBolt11(invoice: string): string {
  const field = parseInvoice(invoice).fields.find(({ type }) => type === TAG_PAYMENT_HASH);
  if (!field) throw new Error("invoice missing payment_hash");
  const bytes = convertBits(field.data, 5, 8, false);
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type Bolt11Expiry = {
  /** When the invoice was created, in unix seconds. */
  timestamp: number;
  /** Seconds the invoice stays payable. */
  expirySecs: number;
  /** `timestamp + expirySecs`, in unix seconds. */
  expiresAt: number;
};

/** The timestamp and expiry of an invoice, with the BOLT11 default of 3600 seconds when it has no `x` field. */
export function expiryFromBolt11(invoice: string): Bolt11Expiry {
  const { timestamp, fields } = parseInvoice(invoice);
  const field = fields.find(({ type }) => type === TAG_EXPIRY);
  const expirySecs = field ? groupsToInt(field.data) : DEFAULT_EXPIRY_SECS;
  return { timestamp, expirySecs, expiresAt: timestamp + expirySecs };
}
