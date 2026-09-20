import Link from 'next/link';

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { emailDeliveryConfigured } from '@/db/env';

import { SignInForm } from './sign-in-form';

/**
 * Sign in.
 *
 * Synchronous and outside the `(app)` group, so it prerenders whole: nothing
 * here reads the session, and a login page that waits on a database is the
 * worst place to spend a round trip.
 *
 * `emailDeliveryConfigured()` reads `process.env` at render, which is not a
 * dynamic API — no request data is involved — so it does not force this page
 * out of the static shell. Only the boolean crosses to the client; the API
 * key and the from-address never leave the server.
 */
export default function SignInPage() {
  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-1 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">duplexd</h1>
          <p className="text-muted-foreground text-sm">
            Manage your voice assistants and the calls they take.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Sign in</CardTitle>
            <CardDescription>
              Use the email and password you signed up with.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {/*
              There is no "Sign in with SSO" here, unlike the reference:
              nothing is wired up behind it, and the first screen a tenant
              sees is the worst possible place to start lying to them.
            */}
            <SignInForm passwordResetAvailable={emailDeliveryConfigured()} />
          </CardContent>
        </Card>

        <p className="text-muted-foreground text-center text-sm">
          No account?{' '}
          <Link
            href="/sign-up"
            className="text-foreground underline underline-offset-4"
          >
            Create one
          </Link>
          .
        </p>
      </div>
    </main>
  );
}
