'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { ArrowLeft } from '@phosphor-icons/react';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
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
  SIGN_UP_STEP_ONE_FIELDS,
  signUpSchema,
  type SignUpValues,
} from '@/lib/auth-schemas';

/**
 * Signing up, in two steps.
 *
 * Step one is the credentials — email, password, confirm. Step two is the two
 * questions that are about *this* product. The confirm field is caught in
 * step one rather than at the final submit; see `SIGN_UP_STEP_ONE_FIELDS`.
 *
 * **One form, one submit.** Both steps are panes of the same React Hook Form,
 * so step one's values are still in hand when step two submits and there is
 * exactly one `signUp.email` call carrying everything. Two separate forms
 * would mean holding the password in state between them, which is worse in
 * every way that matters.
 *
 * The split is about load, not mechanics: five fields and their helper lines
 * on one screen is a lot to meet a product with. Step two is only reachable
 * once step one validates, so nobody names a workspace and is then sent back
 * for a typo in an email they entered two screens ago.
 */
export function SignUpForm() {
  const router = useRouter();
  const [formError, setFormError] = useState<string | null>(null);
  const [step, setStep] = useState<1 | 2>(1);
  const workspaceRef = useRef<HTMLInputElement>(null);

  const {
    control,
    handleSubmit,
    trigger,
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

  /** Advance only if the credentials are good. */
  async function goToStepTwo() {
    if (!(await trigger([...SIGN_UP_STEP_ONE_FIELDS]))) {
      return;
    }

    setStep(2);
    // Focus follows the eye. Without this the caret is still on a field that
    // is no longer visible, and a keyboard user has to tab back into the form.
    window.setTimeout(() => workspaceRef.current?.focus(), 0);
  }

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
      ...({ workspaceName: values.workspaceName } as { workspaceName: string }),
    });

    if (result.error) {
      // Back to step one: every failure this can return — a taken address, a
      // rejected password — belongs to the credentials, and leaving someone on
      // the workspace step with an error about their email is a puzzle.
      setStep(1);
      setFormError('Could not create that account. Check the details and retry.');
      return;
    }

    router.push('/');
    router.refresh();
  }

  return (
    /*
      `method="post"` is deliberate on a form handled in JavaScript. If the
      client bundle fails or is slow, the browser falls back to a native
      submit — and a form with no method defaults to GET, putting the password
      in the URL, the history, the Referer and every proxy log in front of it.
      With POST the degraded case is a harmless request the server ignores.
    */
    <form
      method="post"
      onSubmit={handleSubmit(onSubmit)}
      noValidate
      className="space-y-4"
    >
      <p className="text-muted-foreground text-xs" aria-live="polite">
        Step {step} of 2
      </p>

      {/*
        Both panes stay mounted; the hidden one is `hidden`, not unmounted.
        Unmounting would take step one's inputs out of the form, and the
        degraded native submit above would then post an incomplete body.
      */}
      <div hidden={step !== 1} className="space-y-4">
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

        <Button
          type="button"
          className="h-11 w-full"
          onClick={goToStepTwo}
          data-testid="continue"
        >
          Continue
        </Button>
      </div>

      <div hidden={step !== 2} className="space-y-4">
        <Controller
          control={control}
          name="workspaceName"
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid || undefined}>
              <FieldLabel htmlFor={field.name}>Workspace name</FieldLabel>
              <Input
                {...field}
                ref={workspaceRef}
                id={field.name}
                placeholder="Acme Inc."
                autoComplete="organization"
                className="h-11"
                aria-invalid={fieldState.invalid || undefined}
              />
              <FieldDescription>You can rename it in Settings.</FieldDescription>
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

        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            className="h-11"
            onClick={() => setStep(1)}
            data-testid="back"
          >
            <ArrowLeft aria-hidden="true" />
            Back
          </Button>
          <Button type="submit" className="h-11 flex-1" disabled={isSubmitting}>
            {isSubmitting ? 'Creating account…' : 'Create account'}
          </Button>
        </div>
      </div>
    </form>
  );
}
