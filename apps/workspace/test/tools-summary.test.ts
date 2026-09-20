import { describe, expect, it } from 'vitest';

import { summarizeTools } from '@/lib/tools-summary';

import {
  CANARY,
  expectAbsent,
  flatTool,
  wrappedTool,
} from './helpers/assistant-form/tool-fixtures.ts';

/**
 * The tool summary that sits beside the editor's JSON textarea.
 *
 * Its whole job is to let a customer confirm, without reading JSON, that the
 * twelve tools they pasted are the twelve tools they meant. That makes three
 * things load-bearing, and none of them is "the rows are right":
 *
 *  1. **It is read-only over the raw text.** The textarea submits the exact
 *     bytes the customer typed. A summary that normalised, reformatted or
 *     round-tripped the JSON would be one refactor away from becoming the
 *     source of what gets saved — and `JSON.parse`/`JSON.stringify` is not
 *     lossless: key order survives, but `2.0` becomes `2`, `1e3` becomes
 *     `1000`, and an integer past 2^53 changes value outright. So the summary
 *     returns *rows*, never text, and the tests below pin that shape rather
 *     than trusting the intent.
 *  2. **It never throws.** It runs against a textarea on every keystroke-ish
 *     re-render, over input that is half-typed by definition. An exception here
 *     is a blank page in the middle of someone's work, and the input that
 *     causes it is not exotic — it is a customer three characters into pasting.
 *  3. **It never echoes its input.** A tool list is a place customers put
 *     things they should not: an API key in a description, a bearer token in a
 *     default. A parse error that quotes the offending fragment puts that on
 *     screen, into a screenshot, into a support ticket.
 *
 * The rejection tests carry extra assertions as a group — see
 * "each rejection is distinguishable" at the bottom. A dozen tests that each
 * assert only `ok === false` pass just as happily against an implementation
 * with one generic rejection for everything, which is the same coverage
 * illusion as a validation matrix that never checks *which* rule fired.
 */

type Summary = ReturnType<typeof summarizeTools>;
type Rows = Extract<Summary, { ok: true }>['rows'];

/** Summarises a JavaScript value by way of the string the API actually takes. */
function summarizeValue(value: unknown): Summary {
  return summarizeTools(JSON.stringify(value));
}

/** The rows, or a failure naming the error that came back instead. */
function expectRows(result: Summary): Rows {
  if (!result.ok) {
    throw new Error(`Expected a summary, got an error: ${result.error}`);
  }

  return result.rows;
}

/** The error message, or a failure naming the rows that came back instead. */
function expectError(result: Summary): string {
  if (result.ok) {
    throw new Error(
      `Expected an error, got ${result.rows.length} row(s): ${result.rows
        .map((row) => row.name)
        .join(', ')}`,
    );
  }

  expect(typeof result.error).toBe('string');
  expect(result.error.trim()).not.toBe('');

  return result.error;
}

describe('the shapes a tool list may take', () => {
  it('summarises a flat tool object', () => {
    expect(expectRows(summarizeValue([flatTool()]))).toStrictEqual([
      {
        name: 'lookup_order',
        description: 'Looks up an order by its reference.',
        parameterCount: 1,
      },
    ]);
  });

  /**
   * The wrapped shape is what a customer gets by copying from OpenAI's own
   * documentation, so it is the more likely of the two to arrive in the
   * textarea — not a legacy alias.
   */
  it('summarises a wrapped OpenAI function object identically', () => {
    expect(expectRows(summarizeValue([wrappedTool()]))).toStrictEqual(
      expectRows(summarizeValue([flatTool()])),
    );
  });

  it('accepts both shapes in one list', () => {
    const rows = expectRows(
      summarizeValue([
        flatTool(),
        wrappedTool({ name: 'cancel_order', description: 'Cancels an order.' }),
      ]),
    );

    expect(rows.map((row) => row.name)).toStrictEqual([
      'lookup_order',
      'cancel_order',
    ]);
  });

  it('summarises an empty list as no rows', () => {
    expect(expectRows(summarizeTools('[]'))).toStrictEqual([]);
  });

  /**
   * The summary sits next to the textarea and is read against it. Rows in a
   * different order than the JSON would make that comparison actively
   * misleading for the twelve-tool list this feature exists to serve.
   */
  it('keeps the order of the list', () => {
    const rows = expectRows(
      summarizeValue([
        flatTool({ name: 'c' }),
        flatTool({ name: 'a' }),
        flatTool({ name: 'b' }),
      ]),
    );

    expect(rows.map((row) => row.name)).toStrictEqual(['c', 'a', 'b']);
  });

  it('tolerates whitespace and newlines around the JSON', () => {
    expect(expectRows(summarizeTools(`\n  ${JSON.stringify([flatTool()])}\n `)))
      .toHaveLength(1);
  });
});

describe('counting parameters', () => {
  /** Builds a tool whose `parameters` is exactly the given object. */
  function withParameters(parameters: unknown): Record<string, unknown> {
    return flatTool({ parameters });
  }

  it('counts the top-level properties', () => {
    const rows = expectRows(
      summarizeValue([
        withParameters({
          type: 'object',
          properties: {
            reference: { type: 'string' },
            locale: { type: 'string' },
            includeHistory: { type: 'boolean' },
          },
        }),
      ]),
    );

    expect(rows[0]?.parameterCount).toBe(3);
  });

  /**
   * A nested object schema is one parameter to a caller, not three. Counting
   * recursively would tell a customer their tool takes eight arguments when it
   * takes two, which is worse than showing nothing.
   */
  it('does not count nested properties', () => {
    const rows = expectRows(
      summarizeValue([
        withParameters({
          type: 'object',
          properties: {
            reference: { type: 'string' },
            address: {
              type: 'object',
              properties: {
                line1: { type: 'string' },
                city: { type: 'string' },
                postcode: { type: 'string' },
              },
            },
          },
        }),
      ]),
    );

    expect(rows[0]?.parameterCount).toBe(2);
  });

  /**
   * A tool that takes no arguments is ordinary — "what time is it", "hang up" —
   * and both spellings of it occur in the wild. Neither is an error.
   */
  it('counts a schema with no properties key as zero', () => {
    const rows = expectRows(
      summarizeValue([withParameters({ type: 'object' })]),
    );

    expect(rows[0]?.parameterCount).toBe(0);
  });

  it('counts an empty properties object as zero', () => {
    const rows = expectRows(
      summarizeValue([withParameters({ type: 'object', properties: {} })]),
    );

    expect(rows[0]?.parameterCount).toBe(0);
  });

  /**
   * `required`, `type` and `additionalProperties` are siblings of `properties`,
   * not parameters. An implementation that counted the keys of `parameters`
   * rather than of `parameters.properties` passes every test above that happens
   * to have as many schema keywords as properties, and this is the case that
   * separates them.
   */
  it('counts properties rather than schema keywords', () => {
    const rows = expectRows(
      summarizeValue([
        withParameters({
          type: 'object',
          additionalProperties: false,
          required: ['reference'],
          description: 'The arguments.',
          properties: { reference: { type: 'string' } },
        }),
      ]),
    );

    expect(rows[0]?.parameterCount).toBe(1);
  });

  /**
   * A parameter may legitimately be called `type`, `required` or `length`.
   * Counting by anything other than the key set — filtering out names that look
   * like keywords, or reaching for `.length` on the object — drops these.
   */
  it('counts properties whose names collide with schema keywords', () => {
    const rows = expectRows(
      summarizeValue([
        withParameters({
          type: 'object',
          properties: {
            type: { type: 'string' },
            required: { type: 'boolean' },
            length: { type: 'number' },
          },
        }),
      ]),
    );

    expect(rows[0]?.parameterCount).toBe(3);
  });

  /**
   * `__proto__` in parsed JSON is an ordinary own property — `JSON.parse` does
   * not walk it onto the prototype — but an implementation that copies keys
   * onto a fresh object with `obj[key] = ...` or spreads into `{}` can turn it
   * back into one. The count must include it, and nothing may leak onto
   * `Object.prototype`.
   */
  it('counts a property named __proto__ without polluting the prototype', () => {
    const rows = expectRows(
      summarizeTools(
        '[{"name":"a","description":"d","parameters":{"type":"object",' +
          '"properties":{"__proto__":{"type":"string"},"safe":{"type":"string"}}}}]',
      ),
    );

    expect(rows[0]?.parameterCount).toBe(2);
    expect(Object.prototype).not.toHaveProperty('type');
    expect(({} as Record<string, unknown>).type).toBeUndefined();
  });

  it('counts each tool independently', () => {
    const rows = expectRows(
      summarizeValue([
        withParameters({ type: 'object', properties: { a: {}, b: {} } }),
        flatTool({ name: 'second', parameters: { type: 'object' } }),
      ]),
    );

    expect(rows.map((row) => row.parameterCount)).toStrictEqual([2, 0]);
  });
});

describe('rejecting input the summary cannot describe', () => {
  it('rejects text that is not JSON', () => {
    expectError(summarizeTools('{ not json'));
  });

  it('rejects an empty string', () => {
    expectError(summarizeTools(''));
  });

  it('rejects a lone object rather than a list', () => {
    expectError(summarizeValue(flatTool()));
  });

  it('rejects a JSON scalar', () => {
    expectError(summarizeTools('"lookup_order"'));
    expectError(summarizeTools('42'));
    expectError(summarizeTools('null'));
  });

  it('rejects a list entry that is not an object', () => {
    expectError(summarizeValue(['lookup_order']));
    expectError(summarizeValue([null]));
    expectError(summarizeValue([['lookup_order']]));
  });

  it('rejects a tool with no name', () => {
    const tool = flatTool();

    delete tool.name;

    expectError(summarizeValue([tool]));
  });

  it('rejects a name that is not a string', () => {
    expectError(summarizeValue([flatTool({ name: 7 })]));
  });

  it('rejects a tool with no description', () => {
    const tool = flatTool();

    delete tool.description;

    expectError(summarizeValue([tool]));
  });

  it('rejects a description that is not a string', () => {
    expectError(summarizeValue([flatTool({ description: ['a', 'b'] })]));
  });

  it('rejects a tool with no parameters', () => {
    const tool = flatTool();

    delete tool.parameters;

    expectError(summarizeValue([tool]));
  });

  it('rejects parameters that are not an object', () => {
    expectError(summarizeValue([flatTool({ parameters: 'object' })]));
    expectError(summarizeValue([flatTool({ parameters: null })]));
    expectError(summarizeValue([flatTool({ parameters: [] })]));
  });

  /**
   * Absent `properties` is zero parameters; `properties` that is present and
   * not an object is a mistake in the schema. Folding the second into the first
   * would report "0 parameters" for a tool whose arguments the customer has
   * written as an array — plausible-looking, wrong, and silent.
   */
  it('rejects properties that are present but not an object', () => {
    expectError(
      summarizeValue([
        flatTool({ parameters: { type: 'object', properties: [] } }),
      ]),
    );
    expectError(
      summarizeValue([
        flatTool({ parameters: { type: 'object', properties: 'reference' } }),
      ]),
    );
    expectError(
      summarizeValue([
        flatTool({ parameters: { type: 'object', properties: null } }),
      ]),
    );
  });

  it('rejects a function wrapper with no function object', () => {
    expectError(summarizeValue([{ type: 'function' }]));
  });

  it('rejects a function wrapper whose function is not an object', () => {
    expectError(summarizeValue([{ type: 'function', function: 'lookup' }]));
    expectError(summarizeValue([{ type: 'function', function: null }]));
  });

  /**
   * One bad tool fails the whole summary rather than being dropped from it.
   * A summary that silently omitted the eleventh of twelve tools would be read
   * as "I pasted eleven", and the customer would go looking for the wrong
   * mistake.
   */
  it('rejects the whole list when a single tool is malformed', () => {
    expectError(
      summarizeValue([flatTool(), flatTool({ name: 7 }), flatTool()]),
    );
  });
});

describe('never throwing', () => {
  /**
   * The summary runs over a textarea mid-edit, so every one of these is
   * something a customer produces on the way to valid JSON, not an attack.
   * They must come back as a result, not as an exception.
   */
  const hostile: Array<[label: string, input: string]> = [
    ['an empty string', ''],
    ['whitespace only', '   \n\t  '],
    ['an open bracket', '['],
    ['a half-typed tool', '[{"name": "look'],
    ['a trailing comma', '[{"name":"a","description":"d","parameters":{}},]'],
    ['single quotes', "[{'name':'a'}]"],
    ['the word undefined', 'undefined'],
    ['a byte order mark', '﻿[]'],
    ['a lone surrogate escape', '["\\ud800"]'],
    ['deep nesting', `[${'['.repeat(200)}${']'.repeat(200)}]`],
    ['a prototype key at tool level', '[{"__proto__":{"name":"a"}}]'],
    ['a very large integer', '[{"name":"a","description":"d","parameters":9007199254740993}]'],
    ['NaN', '[NaN]'],
    ['embedded null bytes', '[\\u0000]'],
    ['a raw control character', '["a\0b"]'],
  ];

  it.each(hostile)('returns a result for %s', (_label, input) => {
    const result = summarizeTools(input);

    expect(result).toBeTypeOf('object');
    expect(result).not.toBeNull();
    expect(typeof result.ok).toBe('boolean');
  });
});

describe('not echoing the input', () => {
  /**
   * The control. `expectAbsent` is the detector every test below leans on, and
   * a detector that never fires would make all of them pass against an
   * implementation that echoes everything. This proves it fires.
   */
  it('detects a canary when one is genuinely present', () => {
    expect(() => expectAbsent(`parse failed near ${CANARY}`)).toThrow(CANARY);
    expect(() => expectAbsent('parse failed')).not.toThrow();
  });

  it('does not echo a malformed document', () => {
    expectAbsent(expectError(summarizeTools(`[{"secret": "${CANARY}"`)));
  });

  it('does not echo a rejected tool', () => {
    expectAbsent(
      expectError(
        summarizeValue([flatTool({ name: 7, description: CANARY })]),
      ),
    );
  });

  it('does not echo a value that is the wrong type', () => {
    expectAbsent(expectError(summarizeTools(`"${CANARY}"`)));
  });

  it('does not echo a parameters object it rejected', () => {
    expectAbsent(
      expectError(
        summarizeValue([
          flatTool({
            parameters: { type: 'object', properties: [CANARY] },
          }),
        ]),
      ),
    );
  });

  /**
   * The rule above must not be over-read into "errors may say nothing". A
   * rejection still has to say *which* tool to look at, and it does so by
   * position — which is both safe to display and unambiguous in a way a name is
   * not, since names can be absent, empty or duplicated in exactly the lists
   * that get rejected.
   */
  it('still says which tool is at fault', () => {
    const third = expectError(
      summarizeValue([flatTool(), flatTool(), flatTool({ name: 7 })]),
    );

    expect(third).toContain('3');

    // Positional, not merely "a number appears": a message hard-coded to the
    // first tool would satisfy the assertion above for a fault at index 0.
    expect(third).not.toBe(expectError(summarizeValue([flatTool({ name: 7 })])));
  });
});

describe('each rejection is distinguishable', () => {
  /**
   * The assertions that stop this file from being a long list of `ok === false`.
   *
   * Ten tests that each check only the verdict pass just as happily against an
   * implementation with one generic rejection for everything — the same
   * coverage illusion as a validation matrix that never checks *which* rule
   * fired. So the rejections are compared against each other. Distinctness is
   * asserted rather than exact text, leaving the copy the implementation's to
   * own.
   *
   * The grouping below is the contract as implemented: three kinds of failure
   * are told apart — the document is not JSON, the document is not a list, or a
   * named tool is malformed — and within the third, tools are told apart by
   * position. Which *field* of a tool is at fault is deliberately not
   * distinguished; a message naming the tool leaves a customer with one small
   * object to look at, which is the actionable part, and the server-side
   * `validateTools` remains the authority that names the exact field at save.
   */
  const categories: Array<[kind: string, input: string]> = [
    ['not JSON at all', '{ not json'],
    ['not a list', JSON.stringify(flatTool())],
    ['a malformed tool', JSON.stringify([{ description: 'd', parameters: {} }])],
  ];

  it('tells the three kinds of failure apart', () => {
    const messages = categories.map(([, input]) =>
      expectError(summarizeTools(input)),
    );

    expect(new Set(messages).size).toBe(categories.length);
  });

  it('tells one malformed tool from another by position', () => {
    const messages = [0, 1, 2].map((index) => {
      const tools = [flatTool(), flatTool(), flatTool()];

      tools[index] = flatTool({ description: 7 });

      return expectError(summarizeValue(tools));
    });

    expect(new Set(messages).size).toBe(3);
  });
});

describe('leaving the raw JSON alone', () => {
  /**
   * The editor submits the exact bytes in the textarea. The summary must stay
   * incapable of becoming the thing that produces them, and the way to keep it
   * that way is for it never to hand back text at all.
   *
   * Asserted as an exact key set rather than as "no `normalized` field",
   * because the field that causes this bug will be called something nobody
   * predicted.
   */
  it('returns rows and nothing that could be saved as JSON', () => {
    const result = summarizeValue([flatTool()]);

    expect(Object.keys(result).sort()).toStrictEqual(['ok', 'rows']);
    expect(Object.keys(expectRows(result)[0] ?? {}).sort()).toStrictEqual([
      'description',
      'name',
      'parameterCount',
    ]);
  });

  it('returns only ok and error when it rejects', () => {
    const result = summarizeTools('{ not json');

    expect(Object.keys(result).sort()).toStrictEqual(['error', 'ok']);
  });

  /**
   * The lossy round trip, made concrete. Every value here survives as text and
   * changes under `JSON.parse` then `JSON.stringify`: `2.0` loses its point,
   * `1e3` becomes `1000`, the large integer changes value, and the escape
   * becomes a literal. If any re-serialised form reached the result, a refactor
   * that started writing the summary back to the textarea would corrupt the
   * customer's schema — so the test looks for the re-serialised text anywhere
   * in the result, not just in a field it thought to name.
   */
  it('carries no re-serialised copy of the input', () => {
    const raw =
      '[{"name":"lookup_order","description":"Looks it up.",' +
      '"parameters":{"type":"object","properties":' +
      '{"ratio":{"default":2.0},"count":{"default":1e3},' +
      '"id":{"default":9007199254740993},"tag":{"default":"\\u0041"}}}}]';

    const result = summarizeTools(raw);
    const serialised = JSON.stringify(result);

    expect(expectRows(result)[0]?.parameterCount).toBe(4);
    expect(serialised).not.toContain('"type":"object"');
    expect(serialised).not.toContain('9007199254740992');
    expect(serialised).not.toContain('properties');
  });

  it('does not change the string it was given', () => {
    const raw = JSON.stringify([flatTool()]);
    const copy = `${raw}`;

    summarizeTools(raw);

    expect(raw).toBe(copy);
  });

  /**
   * The parsed tool list is the summary's own working copy, but a shared
   * mutable one would let a later caller see fields an earlier summary added.
   * Summarising the same text twice must give the same answer.
   */
  it('is stable across repeated calls', () => {
    const raw = JSON.stringify([flatTool(), wrappedTool({ name: 'second' })]);

    expect(summarizeTools(raw)).toStrictEqual(summarizeTools(raw));
  });
});
