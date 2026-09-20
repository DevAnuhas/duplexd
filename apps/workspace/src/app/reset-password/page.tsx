import { notFound } from "next/navigation"
import { Suspense } from "react"

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { emailDeliveryConfigured } from "@/db/env"

import { ResetPasswordForm } from "./reset-password-form"

/**
 * Choose a new password.
 *
 * The card frame is static and prerenders; the form streams in behind a
 * boundary because it reads `?token=` with `useSearchParams()`, which
 * suspends during prerender — the search params are not knowable at build
 * time. Next's instant-navigation guide is explicit that `"use client"` does
 * not exempt a hook like that from needing a boundary.
 *
 * 404s when email delivery is unconfigured, for the same reason
 * `/forgot-password` does: no link can have been sent, so no link can be
 * valid here.
 */
export default function ResetPasswordPage() {
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
            <CardTitle>Choose a new password</CardTitle>
            <CardDescription>
              Pick something you haven&rsquo;t used here before.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Suspense
              fallback={
                <div className="space-y-4">
                  <Skeleton className="h-16 w-full" />
                  <Skeleton className="h-16 w-full" />
                  <Skeleton className="h-11 w-full" />
                </div>
              }
            >
              <ResetPasswordForm />
            </Suspense>
          </CardContent>
        </Card>
      </div>
    </main>
  )
}
