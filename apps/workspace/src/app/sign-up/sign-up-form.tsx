'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';

import { PasswordInput } from '@/components/password-input';
import { Button } from '@/components/ui/button';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { authClient } from '@/lib/auth-client';
import {
  PASSWORD_MIN_LENGTH,
  signUpSchema,
  type SignUpValues,
} from '@/lib/auth-schemas';

export function SignUpForm() {
  const router = useRouter();
  const [formError, setFormError] = useState<string | null>(null);

  const {
    control,
    handleSubmit,
    formState: { isSubmitting },
  } = useForm<SignUpValues>({
    resolver: zodResolver(signUpSchema),
    defaultValues: {
      workspaceName: '',
      name: '',
      email: '',
      password: '',
      confirmPassword: '',
    },
  });

  async function onSubmit(values: SignUpValues) {
    setFormError(null);

    /*
      `workspaceName` is not a column on `users` — it names the account. It
      rides along on the signup body because Better Auth's schema for that
      endpoint is an intersection with a catch-all record, so extra keys
      survive validation and reach the create hook, which writes
      `accounts.name`. See `lib/auth.ts`.
    */
    const result = await authClient.signUp.email({
      email: values.email,
      password: values.password,
      name: values.name,
      /*
        The client's generated type lists only Better Auth's own signup
        fields, but the endpoint's runtime schema is an intersection with a
        catch-all record, so this key is carried through untouched. The cast
        is narrow and deliberate: widening the call signature would suggest
        arbitrary fields are supported, when exactly one is.
      */
      ...({ workspaceName: values.workspaceName } as { workspaceName: string }),
    });

    if (result.error) {
      setFormError('Could not create that account. Check the details and retry.');
      return;
    }

    router.push('/');
    router.refresh();
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
        name="workspaceName"
        render={({ field, fieldState }) => (
          <Field data-invalid={fieldState.invalid || undefined}>
            <FieldLabel htmlFor={field.name}>Workspace name</FieldLabel>
            <Input
              {...field}
              id={field.name}
              placeholder="Acme Inc."
              autoComplete="organization"
              className="h-11"
              aria-invalid={fieldState.invalid || undefined}
            />
            <FieldDescription>
              What your organization is called. You can change it in Settings.
            </FieldDescription>
            {fieldState.error && (
              <FieldError>{fieldState.error.message}</FieldError>
            )}
          </Field>
        )}
      />

      <Controller
        control={control}
        name="name"
        render={({ field, fieldState }) => (
          <Field data-invalid={fieldState.invalid || undefined}>
            <FieldLabel htmlFor={field.name}>Your name</FieldLabel>
            <Input
              {...field}
              id={field.name}
              placeholder="Alex Morgan"
              autoComplete="name"
              className="h-11"
              aria-invalid={fieldState.invalid || undefined}
            />
            {fieldState.error && (
              <FieldError>{fieldState.error.message}</FieldError>
            )}
          </Field>
        )}
      />

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
              className="h-11"
              aria-invalid={fieldState.invalid || undefined}
            />
            {/*
              Signup names the account after this address, so say so here
              rather than letting the tenant discover it in the sidebar.
            */}
            <FieldDescription>
              Your organization starts out named after this address.
            </FieldDescription>
            {fieldState.error && (
              <FieldError>{fieldState.error.message}</FieldError>
            )}
          </Field>
        )}
      />

      <Controller
        control={control}
        name="password"
        render={({ field, fieldState }) => (
          <Field data-invalid={fieldState.invalid || undefined}>
            <FieldLabel htmlFor={field.name}>Password</FieldLabel>
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
            <FieldLabel htmlFor={field.name}>Confirm password</FieldLabel>
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
        {isSubmitting ? 'Creating account…' : 'Create account'}
      </Button>
    </form>
  );
}
