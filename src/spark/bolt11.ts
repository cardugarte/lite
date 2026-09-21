const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

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

export function paymentHashFromBolt11(invoice: string): string {
  const data = bech32Values(invoice);
  let i = 7;
  while (i + 3 <= data.length) {
    const type = data[i];
    const dataLength = (data[i + 1] << 5) | data[i + 2];
    i += 3;
    const field = data.slice(i, i + dataLength);
    i += dataLength;
    if (type === 1) {
      const bytes = convertBits(field, 5, 8, false);
      return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
    }
  }
  throw new Error("invoice missing payment_hash");
}
