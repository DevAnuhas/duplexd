'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { PasswordInput } from '@/components/password-input';
import { Button } from '@/components/ui/button';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from '@/components/ui/field';
import { authClient } from '@/lib/auth-client';
import {
  PASSWORD_MIN_LENGTH,
  resetPasswordSchema,
  type ResetPasswordValues,
} from '@/lib/auth-schemas';

/**
 * Choose a new password.
 *
 * The token arrives as `?token=` because Better Auth's
 * `/reset-password/:token` callback validates it and then redirects here
 * carrying it — so a token that is already expired or spent never reaches
 * this form; that request is redirected with `?error=INVALID_TOKEN` instead.
 *
 * `useSearchParams()` suspends during prerender, which is why the page wraps
 * this component in its own `<Suspense>` boundary.
 */
export function ResetPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [formError, setFormError] = useState<string | null>(null);

  const token = searchParams.get('token');
  const linkError = searchParams.get('error');

  const {
    control,
    handleSubmit,
    formState: { isSubmitting },
  } = useForm<ResetPasswordValues>({
    resolver: zodResolver(resetPasswordSchema),
    defaultValues: { password: '', confirmPassword: '' },
  });

  async function onSubmit(values: ResetPasswordValues) {
    if (token === null) {
      return;
    }

    setFormError(null);

    const result = await authClient.resetPassword({
      newPassword: values.password,
      token,
    });

    if (result.error) {
      /*
        The token is single-use and consumed before the password changes, so
        the common failure here is a link used twice or one that expired
        between opening the page and submitting. Say what to do about it
        rather than restating the error.
      */
      setFormError(
        'That reset link is no longer valid. Request a new one and try again.',
      );
      return;
    }

    /*
      The toast is raised before navigating, and survives it: `Toaster` is
      mounted at the root layout, above both pages, so it is not unmounted by
      the transition. Sign-in itself says nothing about the reset — the page
      a person lands on after a successful reset should be the ordinary one.
    */
    toast.success('Password changed. Sign in with your new password.');
    router.push('/sign-in');
    router.refresh();
  }

  if (token === null) {
    return (
      <div className="space-y-4">
        <p role="alert" className="text-sm">
          {linkError === null
            ? 'This page needs a reset link to work.'
            : 'That reset link has expired or has already been used.'}
        </p>
        <Button asChild className="h-11 w-full">
          <Link href="/forgot-password">Request a new link</Link>
        </Button>
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
        name="password"
        render={({ field, fieldState }) => (
          <Field data-invalid={fieldState.invalid || undefined}>
            <FieldLabel htmlFor={field.name}>New password</FieldLabel>
            <PasswordInput
              {...field}
              id={field.name}
              autoComplete="new-password"
              aria-invalid={fieldState.invalid || undefined}
            />
            <FieldDescription>
              At least {PASSWORD_MIN_LENGTH} characters.
            </FieldDescription>
            {fieldState.error && (
              <FieldError>{fieldState.error.message}</FieldError>
            )}
          </Field>
        )}
      />

      <Controller
        control={control}
        name="confirmPassword"
        render={({ field, fieldState }) => (
          <Field data-invalid={fieldState.invalid || undefined}>
            <FieldLabel htmlFor={field.name}>Confirm new password</FieldLabel>
            <PasswordInput
              {...field}
              id={field.name}
              autoComplete="new-password"
              aria-invalid={fieldState.invalid || undefined}
            />
            {fieldState.error && (
              <FieldError>{fieldState.error.message}</FieldError>
            )}
          </Field>
        )}
      />

      {formError !== null && (
        <p role="alert" className="text-destructive text-sm">
          {formError}
        </p>
      )}

      <Button type="submit" className="h-11 w-full" disabled={isSubmitting}>
        {isSubmitting ? 'Saving…' : 'Change password'}
      </Button>
    </form>
  );
}
