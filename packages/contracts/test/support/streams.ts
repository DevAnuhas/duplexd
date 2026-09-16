/**
 * A `ReadableStream` whose queuing strategy has a high-water mark of zero.
 *
 * This is load-bearing for every demand assertion in `ndjson.test.ts`. With the
 * default high-water mark of 1 a Web Stream eagerly pulls one chunk before any
 * consumer asks for it, so a parser that reads ahead and one that does not look
 * identical from the outside. At zero, `pull` runs only while a `read()` is
 * actually pending, which makes `pulls` a faithful count of parser-initiated
 * reads rather than a mix of parser demand and stream prefetch.
 */
export interface ControlledSource {
  stream: ReadableStream<Uint8Array>;
  /** Parser-initiated reads the source has served. */
  readonly pulls: number;
  readonly cancelled: boolean;
  readonly cancelReason: unknown;
  readonly exhausted: boolean;
}

export function controlledStream(chunks: readonly Uint8Array[]): ControlledSource {
  let pulls = 0;
  let cancelled = false;
  let cancelReason: unknown;
  let index = 0;

  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls += 1;
        const chunk = chunks[index];
        if (chunk === undefined) {
          controller.close();
          return;
        }
        index += 1;
        controller.enqueue(chunk);
      },
      cancel(reason) {
        cancelled = true;
        cancelReason = reason;
      },
    },
    new CountQueuingStrategy({ highWaterMark: 0 }),
  );

  return {
    stream,
    get pulls() {
      return pulls;
    },
    get cancelled() {
      return cancelled;
    },
    get cancelReason() {
      return cancelReason;
    },
    get exhausted() {
      return index >= chunks.length;
    },
  };
}

export function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Split bytes at the given absolute offsets, dropping empty pieces. */
export function splitBytes(bytes: Uint8Array, offsets: readonly number[]): Uint8Array[] {
  const bounds = [0, ...offsets, bytes.byteLength]
    .filter((offset) => offset >= 0 && offset <= bytes.byteLength)
    .sort((left, right) => left - right);
  const chunks: Uint8Array[] = [];
  for (let index = 1; index < bounds.length; index += 1) {
    const start = bounds[index - 1] ?? 0;
    const end = bounds[index] ?? 0;
    if (end > start) chunks.push(bytes.subarray(start, end));
  }
  return chunks.length > 0 ? chunks : [bytes];
}

/** One chunk per byte — the harshest arbitrary chunk boundary there is. */
export function byteAtATime(bytes: Uint8Array): Uint8Array[] {
  return Array.from(bytes, (_, index) => bytes.subarray(index, index + 1));
}

export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}
