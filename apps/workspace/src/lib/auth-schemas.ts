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

const email = z
  .email({ error: 'Enter a valid email address.' })
  .max(320, { error: 'That email address is too long.' });

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

export const signUpSchema = z
  .object({
    email,
    password,
    confirmPassword: z.string().min(1, { error: 'Confirm your password.' }),
  })
  /**
   * The mismatch is reported **on the confirm field**, not at the form root:
   * that is the field the customer has to change, and an error floating above
   * both inputs makes them guess which one is wrong.
   */
  .refine((values) => values.password === values.confirmPassword, {
    error: 'Both passwords must match.',
    path: ['confirmPassword'],
  });

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
