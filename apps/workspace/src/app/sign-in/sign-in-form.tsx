"use client"

import { zodResolver } from "@hookform/resolvers/zod"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { Controller, useForm } from "react-hook-form"

import { PasswordInput } from "@/components/password-input"
import { Button } from "@/components/ui/button"
import { Field, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { authClient } from "@/lib/auth-client"
import { signInSchema, type SignInValues } from "@/lib/auth-schemas"

export function SignInForm({
  passwordResetAvailable,
}: {
  passwordResetAvailable: boolean
}) {
  const router = useRouter()
  const [formError, setFormError] = useState<string | null>(null)

  const {
    control,
    handleSubmit,
    formState: { isSubmitting },
  } = useForm<SignInValues>({
    resolver: zodResolver(signInSchema),
    defaultValues: { email: "", password: "" },
  })

  async function onSubmit(values: SignInValues) {
    setFormError(null)

    const result = await authClient.signIn.email(values)

    if (result.error) {
      /*
        One message for every failure. Distinguishing "no such email" from
        "wrong password" turns this form into an account-enumeration oracle:
        an attacker learns which addresses have accounts without ever signing
        in. React Hook Form keeps both fields populated, so a mistyped
        password costs one field rather than the whole form.
      */
      setFormError("Email or password is incorrect.")
      return
    }

    router.push("/")
    router.refresh()
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
            <div className="flex items-center justify-between">
              <FieldLabel htmlFor={field.name}>Password</FieldLabel>
              {/*
                Rendered only when email delivery is actually configured. A
                "Forgot your password?" link that leads to a page which cannot
                send anything is the worst dead button in the product — it is
                pressed by someone already locked out.
              */}
              {passwordResetAvailable && (
                <Link
                  href="/forgot-password"
                  className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                >
                  Forgot your password?
                </Link>
              )}
            </div>
            <PasswordInput
              {...field}
              id={field.name}
              autoComplete="current-password"
              aria-invalid={fieldState.invalid || undefined}
            />
            {fieldState.error && (
              <FieldError>{fieldState.error.message}</FieldError>
            )}
          </Field>
        )}
      />

      {formError !== null && (
        <p role="alert" className="text-sm text-destructive">
          {formError}
        </p>
      )}

      <Button type="submit" className="h-11 w-full" disabled={isSubmitting}>
        {isSubmitting ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  )
}
