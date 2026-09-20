import { describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';

import {
  forgotPasswordSchema,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  resetPasswordSchema,
  signInSchema,
  signUpSchema,
} from '@/lib/auth-schemas';

/**
 * The rules every authentication form is validated against.
 *
 * Nothing is mocked and nothing needs a database: these are pure functions over
 * plain objects, which is most of why they are worth having as a module at all.
 *
 * **Every rejection asserts which rule fired, not merely that something did.**
 * A password refused for being too short and a password refused for not
 * matching its confirmation are the same `success: false`, and only one of them
 * tells the customer what to change. The same goes for *where* the rejection
 * lands: a mismatch reported at the form root instead of on `confirmPassword`
 * makes someone guess which of two boxes to retype, so the path is asserted as
 * carefully as the message.
 *
 * Written against Zod 4 (pinned 4.6.5), where issues carry `path` and `message`
 * and customisation is the `error` key. The Zod 3 idioms — `z.string().email()`,
 * `required_error` — do not apply and would silently produce a schema that
 * validates nothing.
 */

/** A rejection, flattened to the two things a form actually renders. */
type Issue = { path: string; message: string };

/**
 * Every issue a schema produced, or `[]` when it accepted the value.
 *
 * Returning the issues rather than a boolean is the point: a test that can only
 * see `success: false` cannot tell a correct rejection from a rejection for the
 * wrong reason, and those two are the difference between useful copy and copy
 * that misdirects.
 */
function issuesFor(schema: ZodType, value: unknown): Issue[] {
  const result = schema.safeParse(value);

  if (result.success) {
    return [];
  }

  return result.error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));
}

/** Whether the schema accepted the value outright. */
function accepts(schema: ZodType, value: unknown): boolean {
  return issuesFor(schema, value).length === 0;
}

/**
 * One field as the schema *stores* it, or `null` when the value was rejected.
 *
 * Acceptance alone is not the contract for any of the trimming fields. What
 * matters downstream is the normalized value — a schema that let padding
 * through unchanged would satisfy every boolean assertion and still hand
 * Better Auth an address with a space in it, or name a workspace `"  Acme  "`.
 */
function parsedFieldOf(
  schema: ZodType,
  value: unknown,
  field: string,
): string | null {
  const result = schema.safeParse(value);

  if (!result.success) {
    return null;
  }

  const parsed = result.data as Record<string, unknown>;

  return typeof parsed[field] === 'string' ? (parsed[field] as string) : null;
}

/** A password of exactly `length` characters that passes every rule but length. */
function passwordOfLength(length: number): string {
  return 'a'.repeat(length);
}

/**
 * A syntactically valid address of exactly `length` characters.
 *
 * Built rather than hard-coded so the 320/321 boundary cases differ only in
 * length — if the over-length case were also malformed, it would be rejected
 * either way and would prove nothing about the limit.
 */
function emailOfLength(length: number): string {
  const domain = '@example.com';

  return `${'a'.repeat(length - domain.length)}${domain}`;
}

const VALID_EMAIL = 'person@example.com';
const VALID_PASSWORD = passwordOfLength(PASSWORD_MIN_LENGTH);
const VALID_WORKSPACE = 'Acme Logistics';
const VALID_PERSON = 'Alex Doe';

/** The longest name either name field accepts. Mirrors `NAME_MAX_LENGTH`. */
const NAME_MAX_LENGTH = 120;

/**
 * A complete, valid sign-up body with `overrides` applied.
 *
 * Every sign-up case is built from this rather than from a literal, so a field
 * added to `signUpSchema` breaks one helper instead of scattering the same
 * five keys through a dozen tests — which is exactly what happened when
 * `workspaceName` and `name` arrived.
 */
function signUpWith(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    workspaceName: VALID_WORKSPACE,
    name: VALID_PERSON,
    email: VALID_EMAIL,
    password: VALID_PASSWORD,
    // Sign-up is losing its confirm field; reset keeps one. This key is sent
    // anyway because Zod objects strip what they do not declare, so the same
    // body satisfies the schema that still requires it and is ignored by the
    // one that does not. That keeps this file green whichever of the two
    // commits lands first — delete it once the split has settled.
    confirmPassword: VALID_PASSWORD,
    ...overrides,
  };
}

/** The email rule is one shared object, and every schema carrying it must agree. */
const SCHEMAS_WITH_EMAIL = [
  [
    'signInSchema',
    signInSchema,
    (email: string) => ({ email, password: VALID_PASSWORD }),
  ],
  [
    'signUpSchema',
    signUpSchema,
    (email: string) => signUpWith({ email }),
  ],
  [
    'forgotPasswordSchema',
    forgotPasswordSchema,
    (email: string) => ({ email }),
  ],
] as const;

describe('the shared email rule', () => {
  describe.each(SCHEMAS_WITH_EMAIL)('%s', (_name, schema, build) => {
    it.each([
      ['an ordinary address', VALID_EMAIL, VALID_EMAIL],
      ['a subdomain', 'person@mail.example.co.uk', 'person@mail.example.co.uk'],
      ['a plus tag', 'person+duplexd@example.com', 'person+duplexd@example.com'],
      ['exactly the maximum length', emailOfLength(320), emailOfLength(320)],
      ['a space-padded address', `  ${VALID_EMAIL}  `, VALID_EMAIL],
      ['a tab- and newline-padded address', `\t\n ${VALID_EMAIL} \n\t`, VALID_EMAIL],
      [
        'a single trailing space, as a password manager pastes it',
        `${VALID_EMAIL} `,
        VALID_EMAIL,
      ],
      // The bound is measured after trimming, so padding cannot push a legal
      // address over the limit. This is the positive half of the over-length
      // padded case below.
      [
        'padding around an address of exactly the maximum length',
        `  ${emailOfLength(320)}  `,
        emailOfLength(320),
      ],
    ])('accepts %s, and stores it trimmed', (_label, submitted, stored) => {
      expect(
        parsedFieldOf(schema, build(submitted), 'email'),
        'accepted, but the padding survived into the parsed value',
      ).toBe(stored);
    });

    it.each([
      ['the empty string', '', /valid email/i],
      ['no at sign', 'person.example.com', /valid email/i],
      ['no domain', 'person@', /valid email/i],
      ['no local part', '@example.com', /valid email/i],
      // Trimming is the ends and only the ends. Whitespace in the middle is a
      // typo, not padding, and closing it up would submit an address the
      // customer never typed.
      ['a space inside', 'pe rson@example.com', /valid email/i],
      ['a tab inside', 'pe\trson@example.com', /valid email/i],
      // After trimming, these are the empty string, so either rule could
      // plausibly fire. They must read as an invalid address — which is what
      // the field is asking for — rather than as a length complaint.
      ['only whitespace', '   ', /valid email/i],
      ['only a tab and a newline', '\t\n', /valid email/i],
      ['one character over the maximum', emailOfLength(321), /too long/i],
      [
        'padding around an already over-length address',
        `  ${emailOfLength(321)}  `,
        /too long/i,
      ],
    ])('rejects %s, on the email field', (_label, email, expected) => {
      expect(issuesFor(schema, build(email))).toContainEqual({
        path: 'email',
        message: expect.stringMatching(expected),
      });
    });
  });
});

describe('signInSchema', () => {
  it('accepts a valid pair', () => {
    expect(
      accepts(signInSchema, { email: VALID_EMAIL, password: VALID_PASSWORD }),
    ).toBe(true);
  });

  it('rejects an empty password, naming the password field', () => {
    expect(
      issuesFor(signInSchema, { email: VALID_EMAIL, password: '' }),
    ).toStrictEqual([
      { path: 'password', message: expect.stringMatching(/enter your password/i) },
    ]);
  });

  /**
   * **The load-bearing case in this file.**
   *
   * Sign-in deliberately does *not* apply the length minimum. Applying it would
   * tell an attacker which passwords are too short to be real before a single
   * request leaves the browser, and it would lock out any existing account
   * whose password predates the rule — the person it would fail is the one
   * already unable to get in.
   *
   * So this is not a gap being tolerated, it is the behaviour, and a test
   * asserting the minimum here would be asserting a bug. Every length below the
   * sign-up minimum is checked rather than one representative value, because a
   * minimum reintroduced at any point in that range is the same defect.
   */
  it.each(
    Array.from({ length: PASSWORD_MIN_LENGTH - 1 }, (_unused, index) => index + 1),
  )(
    'accepts a %i-character password, because sign-in must not apply the minimum',
    (length) => {
      expect(
        issuesFor(signInSchema, {
          email: VALID_EMAIL,
          password: passwordOfLength(length),
        }),
        'sign-in applied a length rule it must not apply',
      ).toStrictEqual([]);
    },
  );

  /**
   * The other half of that decision: no maximum either. A password longer than
   * the sign-up ceiling still belongs to somebody, and refusing to *submit* it
   * would lock out an account the server would have let in.
   */
  it('accepts a password longer than the sign-up maximum', () => {
    expect(
      accepts(signInSchema, {
        email: VALID_EMAIL,
        password: passwordOfLength(PASSWORD_MAX_LENGTH + 1),
      }),
    ).toBe(true);
  });

  it('rejects a missing password rather than treating it as empty', () => {
    expect(issuesFor(signInSchema, { email: VALID_EMAIL })).toContainEqual({
      path: 'password',
      message: expect.any(String),
    });
  });
});

/**
 * The two schemas that set a *new* password share every rule that matters, so
 * they are checked by the same table. If one ever drifts from the other — a
 * looser minimum on reset, say — this block is what notices.
 */
const PASSWORD_SETTING_SCHEMAS = [
  [
    'signUpSchema',
    signUpSchema,
    (password: string, confirmPassword: string) =>
      signUpWith({ password, confirmPassword }),
  ],
  [
    'resetPasswordSchema',
    resetPasswordSchema,
    (password: string, confirmPassword: string) => ({
      password,
      confirmPassword,
    }),
  ],
] as const;

describe.each(PASSWORD_SETTING_SCHEMAS)('%s', (_name, schema, build) => {
  const atMinimum = passwordOfLength(PASSWORD_MIN_LENGTH);
  const belowMinimum = passwordOfLength(PASSWORD_MIN_LENGTH - 1);
  const atMaximum = passwordOfLength(PASSWORD_MAX_LENGTH);
  const aboveMaximum = passwordOfLength(PASSWORD_MAX_LENGTH + 1);

  it('accepts a password of exactly the minimum length', () => {
    expect(accepts(schema, build(atMinimum, atMinimum))).toBe(true);
  });

  it('accepts a password of exactly the maximum length', () => {
    expect(accepts(schema, build(atMaximum, atMaximum))).toBe(true);
  });

  it('rejects one character below the minimum, naming the length rule', () => {
    expect(issuesFor(schema, build(belowMinimum, belowMinimum))).toStrictEqual([
      {
        path: 'password',
        message: expect.stringMatching(
          new RegExp(`at least ${PASSWORD_MIN_LENGTH}`, 'i'),
        ),
      },
    ]);
  });

  it('rejects one character above the maximum, naming the length rule', () => {
    expect(issuesFor(schema, build(aboveMaximum, aboveMaximum))).toStrictEqual([
      {
        path: 'password',
        message: expect.stringMatching(
          new RegExp(`at most ${PASSWORD_MAX_LENGTH}`, 'i'),
        ),
      },
    ]);
  });

});

/**
 * The two names signup now collects: the workspace's and the person's.
 *
 * They are structurally identical — required, trimmed, capped at 120 — so they
 * share one table. Sharing it is the point rather than a convenience: a rule
 * tightened on one field and forgotten on the other is exactly the drift this
 * catches, and two hand-written blocks would drift silently.
 *
 * `workspaceName` is the higher-stakes of the two. It is not a column on
 * `users`; it rides the signup body to a database hook and becomes
 * `accounts.name`. What this file pins is the *validation*; that it survives
 * the trip and lands on the right row is pinned by
 * `test/signup-workspace-name.test.ts` against a real database.
 */
const NAME_FIELDS = [
  ['workspaceName', /name your workspace/i, /workspace name under 120/i],
  ['name', /enter your name/i, /your name under 120/i],
] as const;

const TRIMMABLE_NAME = 'Acme Logistics';

describe.each(NAME_FIELDS)(
  'signUpSchema %s',
  (field, requiredMessage, tooLongMessage) => {
    it('accepts an ordinary value and stores it unchanged', () => {
      expect(
        parsedFieldOf(signUpSchema, signUpWith({ [field]: TRIMMABLE_NAME }), field),
      ).toBe(TRIMMABLE_NAME);
    });

    it.each([
      ['the empty string', ''],
      ['a single space', ' '],
      ['only whitespace', '   '],
      ['a tab and a newline', '\t\n'],
    ])('rejects %s, naming this field and only this field', (_label, submitted) => {
      const issues = issuesFor(signUpSchema, signUpWith({ [field]: submitted }));

      expect(issues).toContainEqual({
        path: field,
        message: expect.stringMatching(requiredMessage),
      });

      // Not an exact-length assertion: `workspaceName` carries both a `min(1)`
      // and an invisible-character refine, and an empty value trips both with
      // the same message. Harmless — React Hook Form surfaces one error per
      // field — but it means the count is not the contract. What is the
      // contract is that no *other* field gets blamed for this one.
      expect(
        issues.every((issue) => issue.path === field),
        'a different field was blamed for this one',
      ).toBe(true);
    });

    it('rejects the field being absent entirely', () => {
      const body = signUpWith();
      delete body[field];

      expect(issuesFor(signUpSchema, body)).toStrictEqual([
        { path: field, message: expect.stringMatching(requiredMessage) },
      ]);
    });

    /**
     * A non-string reads as the field's own copy, not as Zod's type error.
     * Reachable from a server caller even though the form cannot produce it.
     */
    it.each([
      ['null', null],
      ['a number', 42],
    ])('rejects %s with the same copy an empty value gets', (_label, submitted) => {
      expect(
        issuesFor(signUpSchema, signUpWith({ [field]: submitted })),
      ).toStrictEqual([
        { path: field, message: expect.stringMatching(requiredMessage) },
      ]);
    });

    it('trims the stored value', () => {
      expect(
        parsedFieldOf(
          signUpSchema,
          signUpWith({ [field]: `  \t${TRIMMABLE_NAME}\n  ` }),
          field,
        ),
        'accepted, but the padding survived into the parsed value',
      ).toBe(TRIMMABLE_NAME);
    });

    it('accepts exactly the maximum length', () => {
      const atMaximum = 'x'.repeat(NAME_MAX_LENGTH);

      expect(
        parsedFieldOf(signUpSchema, signUpWith({ [field]: atMaximum }), field),
      ).toBe(atMaximum);
    });

    it('rejects one character over the maximum, naming the length rule', () => {
      expect(
        issuesFor(
          signUpSchema,
          signUpWith({ [field]: 'x'.repeat(NAME_MAX_LENGTH + 1) }),
        ),
      ).toStrictEqual([
        { path: field, message: expect.stringMatching(tooLongMessage) },
      ]);
    });

    /**
     * The cap is measured after trimming, so padding cannot push a legal name
     * over it. The over-length padded case below is the other half.
     */
    it('accepts the maximum length wrapped in padding', () => {
      const atMaximum = 'x'.repeat(NAME_MAX_LENGTH);

      expect(
        parsedFieldOf(
          signUpSchema,
          signUpWith({ [field]: `  ${atMaximum}  ` }),
          field,
        ),
      ).toBe(atMaximum);
    });

    it('still rejects an over-length name that was padded', () => {
      expect(
        issuesFor(
          signUpSchema,
          signUpWith({ [field]: `  ${'x'.repeat(NAME_MAX_LENGTH + 1)}  ` }),
        ),
      ).toStrictEqual([
        { path: field, message: expect.stringMatching(tooLongMessage) },
      ]);
    });
  },
);

/**
 * Password confirmation, which now belongs to **reset only**.
 *
 * Sign-up is dropping its confirm field: the password input has a show/hide
 * toggle, and the owner judged the second box redundant against it. Reset keeps
 * one, and the asymmetry is the interesting part — on reset the person cannot
 * see what they are replacing and has no second attempt behind them, so the
 * confirmation is doing work there that the toggle cannot do for it.
 *
 * This block is deliberately keyed on a list of schemas rather than folded into
 * the shared password table above. The two schemas still share every *length*
 * rule, and they no longer share this one; keeping them in one table would mean
 * the sign-up split had to be unpicked out of assertions about something else.
 */
const SCHEMAS_WITH_CONFIRMATION = [
  ['resetPasswordSchema', resetPasswordSchema] as const,
] as const;

describe.each(SCHEMAS_WITH_CONFIRMATION)('%s confirmation', (_name, schema) => {
  const atMinimum = passwordOfLength(PASSWORD_MIN_LENGTH);
  const belowMinimum = passwordOfLength(PASSWORD_MIN_LENGTH - 1);

  const build = (password: string, confirmPassword: string) => ({
    password,
    confirmPassword,
  });

  /**
   * The mismatch lands **on the confirm field**, which is the one the customer
   * has to retype. An error floating at the form root is the version that makes
   * them guess which of two boxes is wrong, and it is what a careless `.refine`
   * without a `path` produces — so the path is the assertion, not a detail
   * alongside it.
   */
  it('reports a mismatch on confirmPassword, not at the form root', () => {
    expect(issuesFor(schema, build(atMinimum, `${atMinimum}x`))).toStrictEqual([
      { path: 'confirmPassword', message: expect.stringMatching(/match/i) },
    ]);
  });

  it('rejects an empty confirmation, naming the confirm field', () => {
    expect(issuesFor(schema, build(atMinimum, ''))).toContainEqual({
      path: 'confirmPassword',
      message: expect.stringMatching(/confirm your password/i),
    });
  });

  /**
   * A password both too short *and* mismatched reports **both**, in one pass.
   *
   * The intuitive guess is the opposite and it is wrong: Zod 4 evaluates the
   * object-level `.refine` even when the inner fields failed. The
   * customer-visible consequence is the good one — fix both problems from one
   * submission instead of learning about the second after fixing the first — so
   * it is worth protecting rather than merely recording.
   */
  it('reports both the length and the mismatch together', () => {
    expect(
      issuesFor(schema, build(belowMinimum, 'something else')),
    ).toStrictEqual([
      {
        path: 'password',
        message: expect.stringMatching(
          new RegExp(`at least ${PASSWORD_MIN_LENGTH}`, 'i'),
        ),
      },
      { path: 'confirmPassword', message: expect.stringMatching(/match/i) },
    ]);
  });
});

describe('forgotPasswordSchema', () => {
  it('asks for nothing but an address', () => {
    const result = forgotPasswordSchema.safeParse({
      email: VALID_EMAIL,
      password: 'ignored',
    });

    expect(result.success).toBe(true);
    expect(
      result.success && result.data,
      'a stray field survived parsing, so the form could submit more than it collects',
    ).toStrictEqual({ email: VALID_EMAIL });
  });

  /**
   * A non-string reads as an invalid address, not as Zod's own type error.
   *
   * The form cannot produce this — React Hook Form always supplies a string —
   * but the module is imported by server paths too, and "Invalid input:
   * expected string, received undefined" is a stack trace wearing a label.
   */
  it.each([
    ['a missing email', {}],
    ['a null email', { email: null }],
    ['a numeric email', { email: 42 }],
  ])('rejects %s with the same copy a bad address gets', (_label, value) => {
    expect(issuesFor(forgotPasswordSchema, value)).toStrictEqual([
      { path: 'email', message: expect.stringMatching(/valid email/i) },
    ]);
  });
});

/**
 * The constants, and the one thing that can silently invalidate them.
 *
 * `PASSWORD_MIN_LENGTH` and `PASSWORD_MAX_LENGTH` are **hand-copied** from
 * Better Auth's defaults, and the module's own comment says matching them
 * matters in both directions: a looser rule lets the form submit what the
 * server refuses, a stricter one locks out an account whose password predates
 * it. Nothing in the type system connects the two.
 *
 * Pinning the literals catches someone editing `auth-schemas.ts`. It does not
 * catch the other direction — configuring `minPasswordLength` in
 * `src/lib/auth.ts`, which moves the server's rule out from under a schema that
 * still says 8. That is the quieter of the two: the form keeps accepting an
 * 8-character password and the customer meets a server error on a form that
 * told them it was fine.
 *
 * So the second test reads the auth module and asserts the defaults are still
 * what is in force. Asserting on source text is unusual, and it is the same
 * technique `test/database-gating.test.ts` already uses to keep a hand-written
 * list honest; the alternative here is a live Better Auth instance, which needs
 * a database and would turn a pure schema file into a database-gated one for a
 * single assertion.
 */
describe('the password bounds', () => {
  it('match Better Auth 1.7.5 defaults', () => {
    expect(PASSWORD_MIN_LENGTH).toBe(8);
    expect(PASSWORD_MAX_LENGTH).toBe(128);
  });

  it('are not overridden in the Better Auth configuration', async () => {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');

    const source = await readFile(
      fileURLToPath(new URL('../src/lib/auth.ts', import.meta.url)),
      'utf8',
    );

    // Comments mention these names when explaining the defaults, so the match
    // is on an actual assignment rather than on the bare word.
    expect(
      /\bminPasswordLength\s*:/.test(source),
      'src/lib/auth.ts now configures minPasswordLength. PASSWORD_MIN_LENGTH ' +
        'in src/lib/auth-schemas.ts is hand-copied from the default and must ' +
        'be updated to match, or the sign-up form will accept a password the ' +
        'server rejects.',
    ).toBe(false);

    expect(
      /\bmaxPasswordLength\s*:/.test(source),
      'src/lib/auth.ts now configures maxPasswordLength. PASSWORD_MAX_LENGTH ' +
        'in src/lib/auth-schemas.ts must be updated to match.',
    ).toBe(false);
  });
});
