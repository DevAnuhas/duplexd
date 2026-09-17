import { MAX_NDJSON_LINE_BYTES } from './constants.js';

export class NdjsonLineTooLong extends Error {
  constructor(
    public readonly bytes: number,
    public readonly limit: number,
  ) {
    super(`NDJSON line is ${bytes} bytes; limit is ${limit}`);
    this.name = 'NdjsonLineTooLong';
  }
}

export class NdjsonMalformedLine extends Error {
  constructor(public readonly preview: string) {
    super(`Malformed NDJSON line: ${preview}`);
    this.name = 'NdjsonMalformedLine';
  }
}

function append(
  left: Uint8Array<ArrayBufferLike>,
  right: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBufferLike> {
  const joined = new Uint8Array(left.byteLength + right.byteLength);
  joined.set(left);
  joined.set(right, left.byteLength);
  return joined;
}

function parseJsonLine<T>(
  bytes: Uint8Array,
  parseLine: (json: unknown) => T,
): T | undefined {
  const withoutCr =
    bytes.byteLength > 0 && bytes[bytes.byteLength - 1] === 13
      ? bytes.subarray(0, bytes.byteLength - 1)
      : bytes;
  const text = new TextDecoder().decode(withoutCr);
  if (text.trim().length === 0) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new NdjsonMalformedLine(text.slice(0, 120));
  }
  return parseLine(json);
}

export async function* parseNdjson<T>(
  stream: ReadableStream<Uint8Array>,
  parseLine: (json: unknown) => T,
  options: { maxLineBytes?: number } = {},
): AsyncIterable<T> {
  const limit = options.maxLineBytes ?? MAX_NDJSON_LINE_BYTES;
  const reader = stream.getReader();
  let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array();
  let completed = false;

  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        completed = true;
        if (buffer.byteLength > 0) {
          const parsed = parseJsonLine(buffer, parseLine);
          if (parsed !== undefined) yield parsed;
        }
        return;
      }

      const chunk = result.value;
      let offset = 0;
      for (let index = 0; index < chunk.byteLength; index += 1) {
        if (chunk[index] !== 10) continue;
        const fragment = chunk.subarray(offset, index);
        const bytes = buffer.byteLength + fragment.byteLength;
        if (bytes > limit) throw new NdjsonLineTooLong(bytes, limit);
        const line = append(buffer, fragment);
        buffer = new Uint8Array();
        offset = index + 1;
        const parsed = parseJsonLine(line, parseLine);
        if (parsed !== undefined) yield parsed;
      }

      const remainder = chunk.subarray(offset);
      const bytes = buffer.byteLength + remainder.byteLength;
      if (bytes > limit) throw new NdjsonLineTooLong(bytes, limit);
      buffer = append(buffer, remainder);
    }
  } finally {
    if (!completed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function writeNdjson(item: unknown): string {
  const json = JSON.stringify(item);
  if (json === undefined)
    throw new TypeError('NDJSON item is not JSON-serializable');
  return `${json}\n`;
}
