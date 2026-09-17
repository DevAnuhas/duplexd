import { describe, expect, it } from 'vitest';

import {
  CoreEvent,
  HandlerResult,
  MAX_NDJSON_LINE_BYTES,
  NdjsonLineTooLong,
  NdjsonMalformedLine,
  parseNdjson,
  writeNdjson,
} from '@duplexd/contracts';

import {
  loadResultIndex,
  readFixtureBytes,
  SYNTHETIC_TEST_SECRET,
} from './support/fixtures.js';
import { byteAtATime, collect, controlledStream, encode, splitBytes } from './support/streams.js';

const identity = (json: unknown) => json;
const resultIndex = loadResultIndex();

/** A one-shot stream over the given chunks, without demand instrumentation. */
function streamOf(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return controlledStream(chunks).stream;
}

/** A JSON line of exactly `bytes` UTF-8 bytes: `{"a":"…"}` frames in eight. */
function jsonLineOfBytes(bytes: number): string {
  return `{"a":"${'x'.repeat(bytes - 8)}"}`;
}

describe('parseNdjson over the committed result fixtures', () => {
  // Declared as returning `unknown` on purpose: one table drives two line
  // schemas, and the fixtures assert item counts and kinds, not inferred types.
  const schemaFor =
    (name: 'HandlerResult' | 'CoreEvent') =>
    (json: unknown): unknown =>
      name === 'CoreEvent' ? CoreEvent.parse(json) : HandlerResult.parse(json);

  it('has an index entry for every fixture stream and nothing extra', () => {
    const declared = Object.keys(resultIndex).sort();
    expect(declared.length).toBeGreaterThanOrEqual(9);
    for (const name of declared) {
      expect(readFixtureBytes('results', name).byteLength).toBeGreaterThan(0);
    }
  });

  it.each(Object.entries(resultIndex))('%s behaves as the index declares', async (name, entry) => {
    const bytes = readFixtureBytes('results', name);
    const chunks = entry.splitAt === undefined ? [bytes] : splitBytes(bytes, entry.splitAt);
    const items: unknown[] = [];
    let thrown: unknown;

    try {
      for await (const item of parseNdjson(streamOf(chunks), schemaFor(entry.schema))) {
        items.push(item);
      }
    } catch (error) {
      thrown = error;
    }

    expect(items).toHaveLength(entry.expectItems);
    if (entry.expectOutcome === 'done') {
      expect(thrown, `${name} threw unexpectedly`).toBeUndefined();
      if (entry.expectFinalDone !== undefined && entry.schema === 'HandlerResult') {
        const last = items.at(-1) as { kind?: string } | undefined;
        expect(last?.kind === 'done').toBe(entry.expectFinalDone);
      }
      return;
    }

    expect(thrown, `${name} was expected to throw`).toBeDefined();
    switch (entry.expectError) {
      case 'line_too_long':
        expect(thrown).toBeInstanceOf(NdjsonLineTooLong);
        expect((thrown as NdjsonLineTooLong).limit).toBe(MAX_NDJSON_LINE_BYTES);
        expect((thrown as NdjsonLineTooLong).bytes).toBeGreaterThan(MAX_NDJSON_LINE_BYTES);
        break;
      case 'unknown_kind':
      case 'content_too_long':
        // A schema failure from the caller's parseLine, propagated unchanged.
        expect(thrown).not.toBeInstanceOf(NdjsonLineTooLong);
        expect(thrown).not.toBeInstanceOf(NdjsonMalformedLine);
        break;
      default:
        throw new Error(`unhandled expectError: ${String(entry.expectError)}`);
    }
  });

  it('parses the same fixtures one byte at a time', async () => {
    for (const [name, entry] of Object.entries(resultIndex)) {
      if (entry.expectOutcome !== 'done') continue;
      const chunks = byteAtATime(readFixtureBytes('results', name));
      const items = await collect(parseNdjson(streamOf(chunks), schemaFor(entry.schema)));
      expect(items, `${name} split byte-by-byte`).toHaveLength(entry.expectItems);
    }
  });

  it('is instantiated over CoreEvent as readily as HandlerResult', async () => {
    const bytes = readFixtureBytes('results', 'core-event.ndjson');
    const events = await collect(parseNdjson(streamOf([bytes]), (json) => CoreEvent.parse(json)));
    expect(events.map((event) => event.type)).toEqual([
      'session.started',
      'transcript.user.delta',
      'delegation.created',
      'provider.raw',
      'session.closed',
    ]);
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it('accepts a legitimate done-only stream', async () => {
    const bytes = readFixtureBytes('results', 'order-status.ndjson');
    const items = await collect(parseNdjson(streamOf([bytes]), (json) => HandlerResult.parse(json)));
    expect(items).toEqual([{ kind: 'done' }]);
  });
});

describe('parseNdjson framing', () => {
  it('handles multiple lines in one chunk', async () => {
    const items = await collect(
      parseNdjson(streamOf([encode('{"a":1}\n{"a":2}\n{"a":3}\n')]), identity),
    );
    expect(items).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
  });

  it('handles a line split across arbitrary chunk boundaries', async () => {
    const text = '{"a":1}\n{"b":2}\n';
    for (let split = 1; split < text.length; split += 1) {
      const chunks = [encode(text.slice(0, split)), encode(text.slice(split))];
      expect(await collect(parseNdjson(streamOf(chunks), identity)), `split at ${split}`).toEqual([
        { a: 1 },
        { b: 2 },
      ]);
    }
  });

  it('strips a CR before LF without treating it as content', async () => {
    const items = await collect(
      parseNdjson(streamOf([encode('{"a":1}\r\n{"b":2}\r\n')]), identity),
    );
    expect(items).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('skips whitespace-only keepalive lines in both line endings', async () => {
    const items = await collect(
      parseNdjson(streamOf([encode(' \r\n\n\t\n   \n{"a":1}\n \n')]), identity),
    );
    expect(items).toEqual([{ a: 1 }]);
  });

  it('parses a final unterminated line', async () => {
    expect(await collect(parseNdjson(streamOf([encode('{"a":1}\n{"b":2}')]), identity))).toEqual([
      { a: 1 },
      { b: 2 },
    ]);
  });

  it('ignores an unterminated whitespace tail', async () => {
    expect(await collect(parseNdjson(streamOf([encode('{"a":1}\n   ')]), identity))).toEqual([
      { a: 1 },
    ]);
  });

  it('yields nothing for an empty stream', async () => {
    expect(await collect(parseNdjson(streamOf([]), identity))).toEqual([]);
    expect(await collect(parseNdjson(streamOf([encode('')]), identity))).toEqual([]);
    expect(await collect(parseNdjson(streamOf([encode('\n\n\n')]), identity))).toEqual([]);
  });

  it('reassembles a UTF-8 code point split across chunks', async () => {
    const line = encode('{"a":"€ ☃ 𝄞"}\n');
    expect(await collect(parseNdjson(streamOf(byteAtATime(line)), identity))).toEqual([
      { a: '€ ☃ 𝄞' },
    ]);
    // Split squarely inside the three bytes of the euro sign.
    const inside = splitBytes(line, [7, 8]);
    expect(await collect(parseNdjson(streamOf(inside), identity))).toEqual([{ a: '€ ☃ 𝄞' }]);
  });
});

describe('parseNdjson error reporting', () => {
  it('wraps a JSON failure as NdjsonMalformedLine', async () => {
    await expect(collect(parseNdjson(streamOf([encode('{oops\n')]), identity))).rejects.toBeInstanceOf(
      NdjsonMalformedLine,
    );
  });

  it('truncates the malformed-line preview to 120 characters', async () => {
    const line = `{oops ${SYNTHETIC_TEST_SECRET} ${'z'.repeat(400)}\n`;
    const error = await collect(parseNdjson(streamOf([encode(line)]), identity)).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(NdjsonMalformedLine);
    const preview = (error as NdjsonMalformedLine).preview;
    expect(preview.length).toBeLessThanOrEqual(120);
    expect(preview).toBe(line.slice(0, 120));
    expect(preview).not.toContain('z'.repeat(200));
  });

  it('propagates a caller parseLine error unchanged', async () => {
    class CallerError extends Error {}
    const boom = new CallerError('caller rejected the line');
    const error = await collect(
      parseNdjson(streamOf([encode('{"a":1}\n')]), () => {
        throw boom;
      }),
    ).catch((thrown: unknown) => thrown);
    expect(error).toBe(boom);
  });

  it('surfaces a schema failure from the caller rather than wrapping it', async () => {
    const error = await collect(
      parseNdjson(streamOf([encode('{"kind":"mystery"}\n')]), (json) => HandlerResult.parse(json)),
    ).catch((thrown: unknown) => thrown);
    expect(error).not.toBeInstanceOf(NdjsonMalformedLine);
    expect(error).not.toBeInstanceOf(NdjsonLineTooLong);
    expect(error).toBeInstanceOf(Error);
  });
});

describe('the NDJSON byte bound', () => {
  it('accepts a line of exactly the limit and rejects one byte more', async () => {
    const atBound = jsonLineOfBytes(MAX_NDJSON_LINE_BYTES);
    expect(encode(atBound).byteLength).toBe(MAX_NDJSON_LINE_BYTES);
    expect(
      await collect(parseNdjson(streamOf([encode(`${atBound}\n`)]), identity)),
    ).toHaveLength(1);

    const overBound = jsonLineOfBytes(MAX_NDJSON_LINE_BYTES + 1);
    const error = await collect(
      parseNdjson(streamOf([encode(`${overBound}\n`)]), identity),
    ).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(NdjsonLineTooLong);
    expect((error as NdjsonLineTooLong).bytes).toBe(MAX_NDJSON_LINE_BYTES + 1);
    expect((error as NdjsonLineTooLong).limit).toBe(MAX_NDJSON_LINE_BYTES);
  });

  it('excludes the terminating LF from the count', async () => {
    // The at-limit line above already proves it: with the LF counted it would
    // be limit + 1 and would have thrown.
    const atBound = `${jsonLineOfBytes(MAX_NDJSON_LINE_BYTES)}\n`;
    expect(encode(atBound).byteLength).toBe(MAX_NDJSON_LINE_BYTES + 1);
    expect(await collect(parseNdjson(streamOf([encode(atBound)]), identity))).toHaveLength(1);
  });

  it('counts a CR before LF toward the bound and strips it only for parsing', async () => {
    const atBound = jsonLineOfBytes(MAX_NDJSON_LINE_BYTES - 1);
    expect(encode(`${atBound}\r`).byteLength).toBe(MAX_NDJSON_LINE_BYTES);
    expect(await collect(parseNdjson(streamOf([encode(`${atBound}\r\n`)]), identity))).toHaveLength(
      1,
    );

    const overBound = jsonLineOfBytes(MAX_NDJSON_LINE_BYTES);
    expect(encode(`${overBound}\r`).byteLength).toBe(MAX_NDJSON_LINE_BYTES + 1);
    const error = await collect(
      parseNdjson(streamOf([encode(`${overBound}\r\n`)]), identity),
    ).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(NdjsonLineTooLong);
    expect((error as NdjsonLineTooLong).bytes).toBe(MAX_NDJSON_LINE_BYTES + 1);
  });

  it('counts raw UTF-8 bytes rather than JavaScript characters', async () => {
    // 30000 three-byte code points is only 30000 characters but 90000 bytes;
    // a character count would let this line straight through.
    const line = `{"a":"${'€'.repeat(30_000)}"}`;
    expect(line.length).toBeLessThan(MAX_NDJSON_LINE_BYTES);
    expect(encode(line).byteLength).toBeGreaterThan(MAX_NDJSON_LINE_BYTES);
    await expect(
      collect(parseNdjson(streamOf([encode(`${line}\n`)]), identity)),
    ).rejects.toBeInstanceOf(NdjsonLineTooLong);
  });

  it('trips on a multibyte line that crosses the bound mid-chunk', async () => {
    const bytes = encode(`{"a":"${'€'.repeat(30_000)}"}\n`);
    // Cut inside a code point so the crossing is not conveniently aligned.
    const chunks = splitBytes(bytes, [32_001, 65_537]);
    const error = await collect(parseNdjson(streamOf(chunks), identity)).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(NdjsonLineTooLong);
  });

  it('honours an injected maxLineBytes', async () => {
    const options = { maxLineBytes: 16 };
    expect(
      await collect(parseNdjson(streamOf([encode('{"a":1}\n')]), identity, options)),
    ).toHaveLength(1);
    await expect(
      collect(parseNdjson(streamOf([encode('{"a":"0123456789"}\n')]), identity, options)),
    ).rejects.toBeInstanceOf(NdjsonLineTooLong);
  });

  it('throws before requesting another chunk or waiting for a newline', async () => {
    const oversized = encode('x'.repeat(MAX_NDJSON_LINE_BYTES + 1));
    const never = encode('never requested\n');
    const source = controlledStream([oversized, never]);

    const error = await collect(parseNdjson(source.stream, identity)).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(NdjsonLineTooLong);
    // One read served the oversized fragment; the parser must not have gone
    // looking for a newline in the next chunk.
    expect(source.pulls).toBe(1);
    expect(source.exhausted).toBe(false);
  });

  it('trips on an oversized whitespace line before any newline arrives', async () => {
    const source = controlledStream([
      encode(' '.repeat(MAX_NDJSON_LINE_BYTES + 1)),
      encode('\n{"a":1}\n'),
    ]);
    const error = await collect(parseNdjson(source.stream, identity)).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(NdjsonLineTooLong);
    expect(source.pulls).toBe(1);
  });

  it('trips on a partial item accumulated across chunks', async () => {
    const half = Math.ceil((MAX_NDJSON_LINE_BYTES + 1) / 2);
    const source = controlledStream([encode('x'.repeat(half)), encode('x'.repeat(half))]);
    const error = await collect(parseNdjson(source.stream, identity)).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(NdjsonLineTooLong);
    expect((error as NdjsonLineTooLong).bytes).toBe(half * 2);
    expect(source.pulls).toBe(2);
  });
});

describe('parseNdjson is pull-based', () => {
  it('performs at most one read per consumer advance', async () => {
    const source = controlledStream([
      encode('{"a":1}\n'),
      encode('{"a":2}\n'),
      encode('{"a":3}\n'),
    ]);
    const iterator = parseNdjson(source.stream, identity)[Symbol.asyncIterator]();

    expect(source.pulls).toBe(0);
    for (let advance = 1; advance <= 3; advance += 1) {
      const next = await iterator.next();
      expect(next.done).toBe(false);
      expect(source.pulls, `after advance ${advance}`).toBe(advance);
    }
    await iterator.return?.(undefined);
  });

  it('does not parse or yield ahead of demand within one chunk', async () => {
    const parsed: unknown[] = [];
    const source = controlledStream([encode('{"a":1}\n{"a":2}\n{"a":3}\n')]);
    const iterator = parseNdjson(source.stream, (json) => {
      parsed.push(json);
      return json;
    })[Symbol.asyncIterator]();

    await iterator.next();
    // One read served all three lines, but only the first was parsed.
    expect(source.pulls).toBe(1);
    expect(parsed).toEqual([{ a: 1 }]);

    await iterator.next();
    expect(source.pulls).toBe(1);
    expect(parsed).toEqual([{ a: 1 }, { a: 2 }]);

    await iterator.return?.(undefined);
    expect(parsed).toHaveLength(2);
  });

  it('releases the reader lock on normal completion', async () => {
    const source = controlledStream([encode('{"a":1}\n')]);
    await collect(parseNdjson(source.stream, identity));
    expect(source.cancelled).toBe(false);
    // A released lock is the only reason a second reader can be taken.
    expect(() => source.stream.getReader()).not.toThrow();
  });

  it('cancels the reader when the consumer returns early', async () => {
    const parsed: unknown[] = [];
    const source = controlledStream([
      encode('{"a":1}\n'),
      encode('{"a":2}\n'),
      encode('{"a":3}\n'),
    ]);

    for await (const item of parseNdjson(source.stream, (json) => {
      parsed.push(json);
      return json;
    })) {
      expect(item).toEqual({ a: 1 });
      break;
    }

    expect(source.cancelled).toBe(true);
    expect(source.pulls).toBe(1);
    expect(parsed).toEqual([{ a: 1 }]);
    expect(() => source.stream.getReader()).not.toThrow();

    // Nothing further happens once the consumer has walked away.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(source.pulls).toBe(1);
    expect(parsed).toHaveLength(1);
  });

  it('cancels the reader when an error ends the iteration', async () => {
    const parsed: unknown[] = [];
    const source = controlledStream([encode('{oops\n'), encode('{"a":2}\n')]);
    await expect(
      collect(
        parseNdjson(source.stream, (json) => {
          parsed.push(json);
          return json;
        }),
      ),
    ).rejects.toBeInstanceOf(NdjsonMalformedLine);

    expect(source.cancelled).toBe(true);
    expect(source.pulls).toBe(1);
    expect(parsed).toEqual([]);
    expect(() => source.stream.getReader()).not.toThrow();

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(source.pulls).toBe(1);
  });

  it('cancels the reader when the byte bound trips', async () => {
    const source = controlledStream([
      encode('x'.repeat(MAX_NDJSON_LINE_BYTES + 1)),
      encode('\n'),
    ]);
    await expect(collect(parseNdjson(source.stream, identity))).rejects.toBeInstanceOf(
      NdjsonLineTooLong,
    );
    expect(source.cancelled).toBe(true);
  });
});

describe('writeNdjson', () => {
  it('is JSON serialization plus exactly one newline', () => {
    expect(writeNdjson({ kind: 'done' })).toBe('{"kind":"done"}\n');
    expect(writeNdjson([1, 2])).toBe('[1,2]\n');
    expect(writeNdjson(null)).toBe('null\n');
    expect(writeNdjson('text')).toBe('"text"\n');
    expect(writeNdjson(0)).toBe('0\n');
  });

  it('round-trips every supported value through the parser', async () => {
    const items = [
      { kind: 'thinking', content: 'Checking.' },
      { kind: 'commentary', content: 'Confirmed — with a € sign and a 𝄞.' },
      { kind: 'done' },
      { nested: { deep: [1, null, true, 'x'] } },
    ];
    const text = items.map((item) => writeNdjson(item)).join('');
    expect(await collect(parseNdjson(streamOf([encode(text)]), identity))).toEqual(items);
  });

  it('round-trips through the parser one byte at a time', async () => {
    const text = writeNdjson({ content: '€'.repeat(50) });
    const items = await collect(parseNdjson(streamOf(byteAtATime(encode(text))), identity));
    expect(items).toEqual([{ content: '€'.repeat(50) }]);
  });

  it('rejects a value JSON cannot represent rather than fabricating output', () => {
    expect(() => writeNdjson(undefined)).toThrow(TypeError);
    expect(() => writeNdjson(() => undefined)).toThrow(TypeError);
    expect(() => writeNdjson(Symbol('nope'))).toThrow(TypeError);
    expect(() => writeNdjson(10n)).toThrow(TypeError);
  });

  it('propagates a circular-structure failure unchanged', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => writeNdjson(circular)).toThrow(TypeError);
  });

  it('never emits a bare newline for an empty object', () => {
    expect(writeNdjson({})).toBe('{}\n');
  });
});
