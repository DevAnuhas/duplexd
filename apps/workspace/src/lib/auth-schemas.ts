import { z } from 'zod';

/**
 * The shapes every authentication form is validated against.
 *
 * **Directive-free on purpose.** No `'use client'`, no `'use server'` — this
 * module is imported by both the client forms and any server path that needs
 * the same rules, and one definition is what keeps them from drifting. A form
 * that accepts what the server rejects is a bug the customer discovers, not
 * the developer.
 *
 * Written against **Zod 4** (pinned 4.6.5), where `z.email()` is a top-level
 * type rather than `z.string().email()`, and message customisation is the
 * `error` key rather than `required_error` / `invalid_type_error`. The Zod
 * example in Next's shipped `forms.md` is Zod 3 and does not apply here.
 */

/**
 * Better Auth's own default minimum (`minPasswordLength: 8`).
 *
 * Matching it matters in both directions: a looser rule here would let the
 * form submit a password the server refuses, and a stricter one would reject
 * a password an existing account already has — locking that customer out of
 * their own reset form.
 */
export const PASSWORD_MIN_LENGTH = 8;

/** Better Auth's default `maxPasswordLength`. */
export const PASSWORD_MAX_LENGTH = 128;

/**
 * The address, trimmed before it is judged.
 *
 * **The order of this chain is the whole point.** `z.email().trim()` reads the
 * same and does the opposite: it validates first and trims the survivor, so a
 * pasted `"  kevin@example.com  "` is rejected before the trim ever runs.
 * Piping a trimmed string into the email check is what makes the padding
 * invisible to validation.
 *
 * That padding is not an edge case. Password managers, mail clients and
 * spreadsheets all hand over addresses with a trailing space, and the place
 * this bites hardest is `/forgot-password`: the person there is already locked
 * out, and telling them their own address is invalid is the worst false
 * rejection in the product.
 *
 * Trimming is deliberately *only* the ends. An address with whitespace in the
 * middle stays invalid — `"a b@c.com"` is a typo, not padding, and silently
 * closing it up would submit an address the customer never typed.
 *
 * The `z.string()` at the head carries the same message as the email check so
 * a non-string — which a server-side caller can produce even though the form
 * cannot — reads as "Enter a valid email address." rather than leaking Zod's
 * own "Invalid input: expected string, received undefined".
 *
 * `.max(320)` sits after the trim, so the bound applies to the address that
 * would actually be stored rather than to the whitespace around it.
 */
const email = z
  .string({ error: 'Enter a valid email address.' })
  .trim()
  .pipe(
    z
      .email({ error: 'Enter a valid email address.' })
      .max(320, { error: 'That email address is too long.' }),
  );

const password = z
  .string()
  .min(PASSWORD_MIN_LENGTH, {
    error: `Use at least ${PASSWORD_MIN_LENGTH} characters.`,
  })
  .max(PASSWORD_MAX_LENGTH, {
    error: `Use at most ${PASSWORD_MAX_LENGTH} characters.`,
  });

export const signInSchema = z.object({
  email,
  /**
   * **Not `password` — deliberately loose.** Sign-in validates only that
   * something was typed. Applying the length rule here would tell an attacker
   * which passwords are too short to be real before a single request is made,
   * and would lock out any existing account whose password predates the rule.
   */
  password: z.string().min(1, { error: 'Enter your password.' }),
});

/**
 * The longest an organization name may be.
 *
 * **Exported because three places write `accounts.name` and they must agree.**
 * The signup hook, the rename action and this schema all bound it here; when
 * the bound lived only in the form and the rename action, a direct API signup
 * could set a 500-character name that the rename path would then refuse to
 * accept back — and that name renders in the sidebar and breadcrumb of every
 * page.
 */
export const WORKSPACE_NAME_MAX_LENGTH = 120;

/**
 * Characters that render as nothing: whitespace, control codes, and the
 * format category — where U+200B ZERO WIDTH SPACE, U+2060 WORD JOINER,
 * U+FEFF and the bidirectional overrides live.
 *
 * `String.trim()` is not enough on its own. It strips U+00A0, but U+200B has
 * not been whitespace since Unicode 4.0.1, so `'\u200B'.trim()` returns that
 * character unchanged and an emptiness check passes.
 */
const INVISIBLE = /[\s\p{Cc}\p{Cf}]/gu;

/**
 * Whether a display name would render as nothing.
 *
 * **One definition, three callers**, and that is the point: this guard existed
 * at the rename action while the signup hook checked only `trim() !== ''`, so
 * the same zero-width name that Settings refused could be set through the
 * unauthenticated signup endpoint — and then rendered blank in the sidebar and
 * breadcrumb of every page. Three similar guards on one column is how they
 * drift.
 */
export function rendersAsNothing(value: string): boolean {
  return value.replace(INVISIBLE, '') === '';
}

/**
 * The name to store for an account, given whatever a caller supplied.
 *
 * Trims, treats an invisible-only name as absent, falls back, and bounds the
 * result. Used by the signup hook, where there is a sensible fallback; the
 * rename action rejects instead, because an authenticated edit should be told
 * it did nothing rather than silently keep the old value.
 */
export function workspaceNameOrFallback(
  supplied: unknown,
  fallback: string,
): string {
  const trimmed = typeof supplied === 'string' ? supplied.trim() : '';

  return rendersAsNothing(trimmed)
    ? fallback
    : trimmed.slice(0, WORKSPACE_NAME_MAX_LENGTH);
}

/** The organization's display name, set at signup and editable in Settings. */
const workspaceName = z
  .string({ error: 'Name your workspace.' })
  .trim()
  .min(1, { error: 'Name your workspace.' })
  .refine((value) => !rendersAsNothing(value), {
    error: 'Name your workspace.',
  })
  .max(WORKSPACE_NAME_MAX_LENGTH, {
    error: `Keep the workspace name under ${WORKSPACE_NAME_MAX_LENGTH} characters.`,
  });

/** The person's own name, shown in the user menu instead of their address. */
const personName = z
  .string({ error: 'Enter your name.' })
  .trim()
  .min(1, { error: 'Enter your name.' })
  .max(120, { error: 'Keep your name under 120 characters.' });

/**
 * Signing up.
 *
 * **The confirm field stays**, and the reason is recovery rather than
 * belt-and-braces. Two things compound at signup that do not at sign-in:
 *
 *  - `autoSignIn` is on by default in Better Auth and we do not disable it,
 *    so a mistyped password **succeeds silently** — the person is signed in
 *    and nothing looks wrong. The typo surfaces at their next sign-in, days
 *    later, with no memory of what they typed.
 *  - On a deployment without `RESEND_API_KEY`, `/forgot-password` calls
 *    `notFound()`. There is then no self-service recovery at all.
 *
 * Chained, those turn one typo into an account nobody can get back into. The
 * show/hide toggle only helps someone who presses it, and nothing obliges
 * them to. This was removed once to cut a field from the first screen and put
 * back when that chain was traced; the two-step split is what reduces the
 * load instead.
 */
export const signUpSchema = z
  .object({
    workspaceName,
    name: personName,
    email,
    password,
    confirmPassword: z.string().min(1, { error: 'Confirm your password.' }),
  })
  /**
   * Reported **on the confirm field**, not at the form root: that is the field
   * the customer has to change, and an error floating above both inputs makes
   * them guess which one is wrong.
   */
  .refine((values) => values.password === values.confirmPassword, {
    error: 'Both passwords must match.',
    path: ['confirmPassword'],
  });

/**
 * The fields step one collects, validated before the form advances.
 *
 * `confirmPassword` is in the list so the mismatch is caught **here** rather
 * than at the final submit — being sent back to a password you entered two
 * screens ago is the failure the split exists to avoid.
 */
export const SIGN_UP_STEP_ONE_FIELDS = [
  'email',
  'password',
  'confirmPassword',
] as const;

export const forgotPasswordSchema = z.object({ email });

export const resetPasswordSchema = z
  .object({
    password,
    confirmPassword: z.string().min(1, { error: 'Confirm your password.' }),
  })
  .refine((values) => values.password === values.confirmPassword, {
    error: 'Both passwords must match.',
    path: ['confirmPassword'],
  });

export type SignInValues = z.infer<typeof signInSchema>;
export type SignUpValues = z.infer<typeof signUpSchema>;
export type ForgotPasswordValues = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordValues = z.infer<typeof resetPasswordSchema>;
