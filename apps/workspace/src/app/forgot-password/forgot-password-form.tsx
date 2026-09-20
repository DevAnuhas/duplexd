'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';

import { Button } from '@/components/ui/button';
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { authClient } from '@/lib/auth-client';
import {
  forgotPasswordSchema,
  type ForgotPasswordValues,
} from '@/lib/auth-schemas';

/**
 * The copy shown after a request, whatever happened.
 *
 * Declared once as a constant so no future branch can accidentally give the
 * two outcomes different words.
 */
const SENT_MESSAGE =
  "If an account exists for that address, we've sent a reset link.";

export function ForgotPasswordForm() {
  const [sent, setSent] = useState(false);

  const {
    control,
    handleSubmit,
    formState: { isSubmitting },
  } = useForm<ForgotPasswordValues>({
    resolver: zodResolver(forgotPasswordSchema),
    defaultValues: { email: '' },
  });

  /**
   * **One outcome, always.**
   *
   * The result of `requestPasswordReset` is deliberately ignored. Better Auth
   * already returns an identical body for a known and an unknown address, and
   * this form must not undo that by rendering an error the endpoint did not
   * make visible. A rejected promise — the network died, the provider is
   * down — lands in the same place, because "we couldn't find that account"
   * and "our mail provider is down" are the two messages that, side by side,
   * tell an attacker which addresses are registered.
   *
   * The cost of the honesty tradeoff is real and accepted: someone who
   * mistypes their address is told a link was sent and never receives one.
   * The copy is written for that person — "if an account exists" rather than
   * "check your inbox" — so it never asserts something that may be false.
   */
  async function onSubmit(values: ForgotPasswordValues) {
    try {
      await authClient.requestPasswordReset({
        email: values.email,
        redirectTo: '/reset-password',
      });
    } catch {
      // Intentionally empty. See above.
    } finally {
      setSent(true);
    }
  }

  if (sent) {
    return (
      <div className="space-y-4">
        <p role="status" className="text-sm">
          {SENT_MESSAGE}
        </p>
        <p className="text-muted-foreground text-sm">
          The link expires in one hour and can be used once. Check your spam
          folder before asking for another.
        </p>
      </div>
    );
  }

  return (
    <form
      method="post"
      onSubmit={handleSubmit(onSubmit)}
      noValidate
      className="space-y-4"
    >
      <Controller
        control={control}
        name="email"
        render={({ field, fieldState }) => (
          <Field data-invalid={fieldState.invalid || undefined}>
            <FieldLabel htmlFor={field.name}>Email</FieldLabel>
            <Input
              {...field}
              id={field.name}
              type="email"
              autoComplete="email"
              aria-invalid={fieldState.invalid || undefined}
            />
            {fieldState.error && (
              <FieldError>{fieldState.error.message}</FieldError>
            )}
          </Field>
        )}
      />

      <Button type="submit" className="w-full" disabled={isSubmitting}>
        {isSubmitting ? 'Sending…' : 'Send reset link'}
      </Button>
    </form>
  );
}
