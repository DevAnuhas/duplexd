import Link from "next/link"
import { notFound } from "next/navigation"

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { emailDeliveryConfigured } from "@/db/env"

import { ForgotPasswordForm } from "./forgot-password-form"

/**
 * Request a password reset link.
 *
 * **404s when email is not configured.** The sign-in page hides the link in
 * that case, but the URL is still typeable, and a form that collects an
 * address it can do nothing with is worse than a missing page — it tells
 * someone locked out that help is coming when none is. Not found is the
 * truthful answer: on this deployment, this page does not exist.
 */
export default function ForgotPasswordPage() {
  if (!emailDeliveryConfigured()) {
    notFound()
  }

  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-1 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">duplexd</h1>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Reset your password</CardTitle>
            <CardDescription>
              Enter the address you signed up with and we&rsquo;ll send a link
              to choose a new password.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ForgotPasswordForm />
          </CardContent>
        </Card>

        <p className="text-center text-sm text-muted-foreground">
          Remembered it?{" "}
          <Link
            href="/sign-in"
            className="text-foreground underline underline-offset-4"
          >
            Sign in
          </Link>
          .
        </p>
      </div>
    </main>
  )
}
