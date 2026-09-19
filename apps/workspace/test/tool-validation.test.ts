import { describe, expect, it } from 'vitest';

import { validateTools } from '@/lib/validate';

/**
 * Tool-list validation, in the OpenAI function format.
 *
 * This is where the ticket said the sprint would be hardest, and the reason is
 * the failure mode rather than the rules: a customer writes JSON Schema by
 * hand, gets it subtly wrong, saves happily, and finds out when a voice call
 * silently does nothing with a caller on the line. So the rules are checked at
 * save, and every message has to say **which** tool is wrong — "invalid tool
 * list" against twelve tools tells the customer nothing.
 *
 * Every assertion below about a message naming its tool is load-bearing. A
 * change that made the rejection generic would still reject the right lists,
 * and would still pass a test that only counted issues.
 */

/** A tool that is valid in every respect, so cases differ in exactly one way. */
function validTool(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'lookup_order',
    description: 'Looks up an order by its reference.',
    parameters: {
      type: 'object',
      properties: { reference: { type: 'string' } },
      required: ['reference'],
    },
    ...overrides,
  };
}

describe('a valid tool list', () => {
  it('is accepted', () => {
    expect(validateTools([validTool()])).toStrictEqual([]);
  });

  it('is accepted with several tools', () => {
    expect(
      validateTools([
        validTool(),
        validTool({ name: 'cancel-order', description: 'Cancels an order.' }),
        validTool({ name: 'A1_b-2', description: 'Does a thing.' }),
      ]),
    ).toStrictEqual([]);
  });

  it('accepts parameters with no properties at all', () => {
    expect(
      validateTools([validTool({ parameters: { type: 'object' } })]),
    ).toStrictEqual([]);
  });

  it.each([
    ['an empty list', []],
    ['undefined', undefined],
    ['null', null],
  ])('accepts %s — an assistant need not have tools', (_label, value) => {
    expect(validateTools(value)).toStrictEqual([]);
  });

  it.each([
    ['an object', { name: 'x' }],
    ['a string', '[]'],
    ['a number', 1],
  ])('rejects %s, which is not a list', (_label, value) => {
    const issues = validateTools(value);

    expect(issues).toHaveLength(1);
    expect(issues[0]?.field).toBe('tools');
  });
});

describe('the name rule', () => {
  const sixtyFour = 'a'.repeat(64);

  it.each([
    ['a single character', 'a'],
    ['underscores', 'lookup_order'],
    ['hyphens', 'lookup-order'],
    ['digits', 'lookup2'],
    ['sixty-four characters', sixtyFour],
  ])('accepts %s', (_label, name) => {
    expect(validateTools([validTool({ name })])).toStrictEqual([]);
  });

  it.each([
    ['the empty string', ''],
    ['sixty-five characters', `${sixtyFour}a`],
    ['a space', 'lookup order'],
    ['a dot', 'lookup.order'],
    ['a slash', 'lookup/order'],
    ['a non-ASCII character', 'lookup_ordér'],
    ['a number rather than a string', 42],
    ['a missing name', undefined],
  ])('rejects %s', (_label, name) => {
    const tool = validTool();
    if (name === undefined) {
      delete tool.name;
    } else {
      tool.name = name;
    }

    const issues = validateTools([tool]);

    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((issue) => /name/i.test(issue.message))).toBe(true);
  });
});

describe('the description rule', () => {
  it.each([
    ['a missing description', undefined],
    ['an empty description', ''],
    ['a whitespace-only description', '   '],
    ['a non-string description', 7],
  ])('rejects %s', (_label, description) => {
    const tool = validTool();
    if (description === undefined) {
      delete tool.description;
    } else {
      tool.description = description;
    }

    const issues = validateTools([tool]);

    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('lookup_order');
    expect(issues[0]?.message).toMatch(/description/i);
  });
});

describe('the parameters rule', () => {
  it.each([
    ['missing', undefined],
    ['null', null],
    ['a list', []],
    ['a string', '{"type":"object"}'],
    ['a number', 3],
    ['a boolean', true],
  ])('rejects parameters that are %s', (_label, parameters) => {
    const tool = validTool();
    if (parameters === undefined) {
      delete tool.parameters;
    } else {
      tool.parameters = parameters;
    }

    const issues = validateTools([tool]);

    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('lookup_order');
  });

  /**
   * `type: "object"` specifically, not merely "some schema". The provider
   * requires a top-level object for a function's arguments, and a schema that
   * describes a string or an array would be accepted by a bare JSON Schema
   * check and then fail at call time, which is the outcome this whole file
   * exists to prevent.
   */
  it.each([
    ['string', { type: 'string' }],
    ['array', { type: 'array', items: { type: 'string' } }],
    ['number', { type: 'number' }],
    ['absent', { properties: { x: { type: 'string' } } }],
  ])('rejects parameters whose type is %s', (_label, parameters) => {
    const issues = validateTools([validTool({ parameters })]);

    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('lookup_order');
    expect(issues[0]?.message).toContain('object');
  });

  /**
   * "Valid JSON Schema" is defined operationally as "Ajv compiles it", because
   * two implementations can disagree about the phrase and then disagree about
   * which tool lists to accept. Each of these has `type: "object"` and is
   * still not a schema — they are the shapes a customer writing one by hand
   * actually produces.
   */
  it.each([
    ['an unknown type in a property', { type: 'object', properties: { x: { type: 'nonsense' } } }],
    ['required as a string rather than a list', { type: 'object', required: 'reference' }],
    ['properties as a string', { type: 'object', properties: 'reference' }],
    ['a non-numeric minimum', { type: 'object', properties: { x: { minimum: 'five' } } }],
    ['additionalProperties as a number', { type: 'object', additionalProperties: 5 }],
  ])('rejects %s, which does not compile', (_label, parameters) => {
    const issues = validateTools([validTool({ parameters })]);

    expect(issues).toHaveLength(1);
    expect(issues[0]?.field).toBe('tools');
    expect(issues[0]?.message).toContain('lookup_order');
  });
});

/**
 * The contract's requirement, asserted on its own rather than as a by-product.
 *
 * A rejection that does not say which tool is wrong sends the customer to read
 * twelve JSON blobs. These tests fail if the tool's name is dropped from the
 * message, which no count-based assertion would notice.
 */
describe('every message identifies the offending tool', () => {
  it('names the tool when the tool has a usable name', () => {
    const issues = validateTools([
      validTool({ name: 'first_tool' }),
      validTool({ name: 'second_tool' }),
      validTool({ name: 'broken_tool', parameters: { type: 'object', required: 'x' } }),
      validTool({ name: 'fourth_tool' }),
    ]);

    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('broken_tool');
    expect(issues[0]?.message).not.toContain('first_tool');
    expect(issues[0]?.message).not.toContain('fourth_tool');
  });

  /**
   * When the name is the broken part there is nothing to quote, so the message
   * falls back to the tool's position in the list. Either form identifies it;
   * neither being present would not.
   */
  it('falls back to the position when the name itself is unusable', () => {
    const tool = validTool();
    delete tool.name;

    const issues = validateTools([validTool({ name: 'fine_one' }), validTool({ name: 'fine_two' }), tool]);

    expect(issues.length).toBeGreaterThan(0);

    for (const issue of issues) {
      expect(issue.message, `"${issue.message}" identifies no tool`).toContain('tool 3');
    }
  });

  it('names each offender when several tools are wrong', () => {
    const issues = validateTools([
      validTool({ name: 'alpha_tool', description: '' }),
      validTool({ name: 'beta_tool' }),
      validTool({ name: 'gamma_tool', parameters: { type: 'string' } }),
    ]);

    expect(issues).toHaveLength(2);

    const messages = issues.map((issue) => issue.message).join('\n');

    expect(messages).toContain('alpha_tool');
    expect(messages).toContain('gamma_tool');
    expect(messages).not.toContain('beta_tool');
  });

  it('identifies a tool that is not an object at all by its position', () => {
    const issues = validateTools([validTool(), 'not a tool']);

    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('tool 2');
  });
});

/**
 * The format is stored unchanged, so validation must not be the place a
 * translation layer sneaks in: what goes in is what a customer already knows
 * from Vapi and OpenAI, and what the agent hands the model.
 */
describe('the stored format', () => {
  it('does not mutate the tool list it validates', () => {
    const tools = [validTool(), validTool({ name: 'second_tool' })];
    const before = JSON.stringify(tools);

    validateTools(tools);

    expect(JSON.stringify(tools)).toBe(before);
  });

  it('accepts extra provider fields rather than stripping them', () => {
    expect(
      validateTools([validTool({ strict: true, extra: { anything: 1 } })]),
    ).toStrictEqual([]);
  });
});
