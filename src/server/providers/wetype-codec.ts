import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';

export function varint(value: number | bigint): Buffer {
  let n = BigInt(value);
  if (n < 0n) throw new Error('Invalid unsigned integer');
  const out: number[] = [];
  do {
    out.push(Number(n & 127n) | (n > 127n ? 128 : 0));
    n >>= 7n;
  } while (n);
  return Buffer.from(out);
}

export const uint = (field: number, value: number | bigint | string): Buffer => Buffer.concat([varint(field * 8), varint(BigInt(value))]);

export const bytes = (field: number, value: string | Buffer): Buffer => {
  const data = Buffer.from(value);
  return Buffer.concat([varint(field * 8 + 2), varint(data.length), data]);
};

export type Field = [number, bigint | Buffer];

export function parse(data: Buffer): Field[] {
  const fields: Field[] = [];
  let at = 0;
  const read = (): bigint => {
    let n = 0n;
    for (let i = 0; i < 10 && at < data.length; i++) {
      const b = data[at++]!;
      n |= BigInt(b & 127) << BigInt(i * 7);
      if (!(b & 128)) return n;
    }
    throw new Error('Invalid WeType protobuf integer');
  };
  while (at < data.length) {
    const tag = Number(read());
    const number = Math.floor(tag / 8);
    const wire = tag % 8;
    if (!number) throw new Error('Invalid WeType protobuf field');
    if (wire === 0) fields.push([number, read()]);
    else if (wire === 2) {
      const length = Number(read());
      if (!Number.isSafeInteger(length) || at + length > data.length) throw new Error('Truncated WeType protobuf');
      fields.push([number, data.subarray(at, at + length)]);
      at += length;
    } else if (wire === 1 || wire === 5) {
      at += wire === 1 ? 8 : 4;
      if (at > data.length) throw new Error('Truncated WeType protobuf');
    } else throw new Error('Invalid WeType protobuf wire type');
  }
  return fields;
}

export const field = (data: Buffer, number: number): bigint | Buffer | undefined => parse(data).find(([n]) => n === number)?.[1];
export const bufferField = (data: Buffer, number: number): Buffer | undefined => {
  const value = field(data, number);
  return Buffer.isBuffer(value) ? value : undefined;
};
export const intField = (data: Buffer, number: number): bigint | undefined => {
  const value = field(data, number);
  return typeof value === 'bigint' ? value : undefined;
};

export const hash = (algorithm: string, data: string | Buffer): string => createHash(algorithm).update(data).digest('hex').toUpperCase();

export function crypt(key: string, data: Buffer, decrypt = false): Buffer {
  const k = Buffer.from(key, 'ascii');
  const cipher = decrypt ? createDecipheriv('aes-256-ecb', k, null) : createCipheriv('aes-256-ecb', k, null);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

export function compress(data: Buffer): Buffer {
  const parts: Buffer[] = [varint(data.length)];
  for (let i = 0; i < data.length; i += 65536) {
    const chunk = data.subarray(i, i + 65536);
    const n = chunk.length - 1;
    parts.push(Buffer.from(n < 60 ? [n << 2] : n < 256 ? [240, n] : [244, n & 255, n >> 8]), chunk);
  }
  return Buffer.concat(parts);
}

export function decompress(data: Buffer): Buffer {
  let at = 0;
  let size = 0;
  let shift = 0;
  for (;;) {
    if (at >= data.length || shift > 28) throw new Error('Invalid Snappy size');
    const b = data[at++]!;
    size += (b & 127) * 2 ** shift;
    if (!(b & 128)) break;
    shift += 7;
  }
  if (size > 1024 * 1024) throw new Error('WeType response is too large');
  const out = Buffer.alloc(size);
  let written = 0;
  const readLE = (n: number): number => {
    if (at + n > data.length) throw new Error('Truncated Snappy data');
    const value = data.readUIntLE(at, n);
    at += n;
    return value;
  };
  while (at < data.length) {
    const tag = data[at++]!;
    const type = tag & 3;
    if (type === 0) {
      let length = tag >> 2;
      if (length >= 60) length = readLE(length - 59);
      length++;
      if (at + length > data.length || written + length > size) throw new Error('Invalid Snappy literal');
      data.copy(out, written, at, at + length);
      at += length;
      written += length;
    } else {
      const length = type === 1 ? ((tag >> 2) & 7) + 4 : (tag >> 2) + 1;
      const offset = type === 1 ? (tag >> 5) * 256 + readLE(1) : readLE(type === 2 ? 2 : 4);
      if (!offset || offset > written || written + length > size) throw new Error('Invalid Snappy copy');
      for (let i = 0; i < length; i++, written++) out[written] = out[written - offset]!;
    }
  }
  if (written !== size) throw new Error('Truncated Snappy output');
  return out;
}

export function request(task: number, path: string, headers: Record<string, string | number>, body: Buffer): Buffer {
  const http = Buffer.concat([
    bytes(1, 'POST'),
    bytes(3, path),
    bytes(4, ''),
    ...Object.entries(headers).map(([k, v]) => bytes(5, Buffer.concat([bytes(1, k), bytes(2, String(v))]))),
    bytes(6, body),
  ]);
  return Buffer.concat([uint(1, 0), uint(2, 0), uint(3, task), bytes(5, http)]);
}

export function response(data: Buffer): { seq: number; status: number; headers: Record<string, string>; body: Buffer } | null {
  const seq = Number(intField(data, 2) ?? 0n);
  if (!seq) return null;
  const http = bufferField(data, 4);
  if (!http) throw new Error('Missing WeType HTTP response');
  const headers: Record<string, string> = {};
  for (const [n, value] of parse(http)) {
    if (n === 4 && Buffer.isBuffer(value)) {
      const key = bufferField(value, 1)?.toString().toLowerCase();
      if (key) headers[key] = bufferField(value, 2)?.toString() ?? '';
    }
  }
  return { seq, status: Number(intField(http, 2) ?? 0n), headers, body: bufferField(http, 5) ?? Buffer.alloc(0) };
}

export class OggOpusPackets {
  private carry: Buffer = Buffer.alloc(0);
  private packet: Buffer[] = [];
  private packetSize = 0;

  constructor(private readonly onPacket: (packet: Buffer) => void) {}

  write(data: Buffer): void {
    this.carry = Buffer.concat([this.carry, data]);
    while (this.carry.length >= 27) {
      const page = this.carry;
      if (page.toString('ascii', 0, 4) !== 'OggS' || page[4] !== 0) throw new Error('Invalid Opus encoder output');
      const segments = page[26]!;
      const start = 27 + segments;
      if (page.length < start) return;
      let end = start;
      for (let i = 27; i < start; i++) end += page[i]!;
      if (page.length < end) return;
      let at = start;
      for (let i = 27; i < start; i++) {
        const size = page[i]!;
        this.packet.push(page.subarray(at, at + size));
        this.packetSize += size;
        if (this.packetSize > 65536) throw new Error('Opus packet is too large');
        at += size;
        if (size < 255) {
          const packet = Buffer.concat(this.packet);
          this.packet = [];
          this.packetSize = 0;
          if (!['OpusHead', 'OpusTags'].includes(packet.toString('ascii', 0, 8))) this.onPacket(packet);
        }
      }
      this.carry = page.subarray(end);
    }
  }

  finish(): void {
    if (this.carry.length || this.packetSize) throw new Error('Truncated Opus encoder output');
  }
}
