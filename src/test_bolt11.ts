const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values: number[]): number {
  let checksum = 1;
  for (const value of values) {
    const top = checksum >> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i++) {
      if ((top >> i) & 1) checksum ^= GENERATOR[i];
    }
  }
  return checksum;
}

function bech32Encode(hrp: string, data: number[]): string {
  const expanded = [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];
  const mod = polymod([...expanded, ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = Array.from({ length: 6 }, (_, i) => (mod >> (5 * (5 - i))) & 31);
  return `${hrp}1${[...data, ...checksum].map((value) => CHARSET[value]).join("")}`;
}

/** An integer as big-endian 5-bit groups, `minLength` groups at least. */
function intToGroups(value: number, minLength = 1): number[] {
  const groups: number[] = [];
  for (let rest = value; rest > 0; rest = Math.floor(rest / 32)) groups.unshift(rest % 32);
  while (groups.length < minLength) groups.unshift(0);
  return groups;
}

function hexToGroups(hex: string): number[] {
  const groups: number[] = [];
  let accumulator = 0;
  let bits = 0;
  for (let i = 0; i < hex.length; i += 2) {
    accumulator = (accumulator << 8) | parseInt(hex.slice(i, i + 2), 16);
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      groups.push((accumulator >> bits) & 31);
    }
    accumulator &= (1 << bits) - 1;
  }
  if (bits > 0) groups.push((accumulator << (5 - bits)) & 31);
  return groups;
}

const field = (type: string, data: number[]): number[] => [
  CHARSET.indexOf(type),
  data.length >> 5,
  data.length & 31,
  ...data,
];

/**
 * A BOLT11 invoice for tests: a timestamp, the payment hash, an optional
 * expiry (`x`) field, a valid bech32 checksum and a signature of `signature`
 * groups (zeros by default). Nothing verifies the signature. Tests only.
 */
export function makeInvoice(parts: {
  paymentHash: string;
  /** Creation time, unix seconds. */
  timestamp: number;
  /** Expiry in seconds. Left out, the invoice has no `x` field and the BOLT11 default of 3600 applies. */
  expirySecs?: number;
  signature?: number[];
}): string {
  const data = [
    ...intToGroups(parts.timestamp, 7),
    ...field("p", hexToGroups(parts.paymentHash)),
    ...(parts.expirySecs === undefined ? [] : field("x", intToGroups(parts.expirySecs))),
    ...(parts.signature ?? new Array<number>(104).fill(0)),
  ];
  return bech32Encode("lnbc", data);
}
