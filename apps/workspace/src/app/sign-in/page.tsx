'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { authClient } from '@/lib/auth-client';

export default function SignInPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const result = await authClient.signIn.email({ email, password });

    setBusy(false);

    if (result.error) {
      // One message for every failure. Distinguishing "no such email" from
      // "wrong password" turns this form into an account-enumeration oracle.
      // The email stays in state so a typo in the password costs one field.
      setError('Email or password is incorrect.');
      return;
    }

    router.push('/');
    router.refresh();
  }

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
              `method="post"` is deliberate on a form handled in JavaScript. If
              the client bundle fails or is slow, the browser falls back to a
              native submit — and a form with no method defaults to GET,
              putting the password in the URL, the history, the Referer and
              every proxy log in front of it. With POST the degraded case is a
              harmless request the server ignores.

              There is no "Sign in with SSO" and no "Forgot your password?"
              here, unlike the reference: neither is wired up, and a link to
              nowhere on the first screen a tenant sees is the worst possible
              place to start lying to them.
            */}
            <form method="post" onSubmit={onSubmit} className="space-y-4">
              <Field>
                <FieldLabel htmlFor="email">Email</FieldLabel>
                <Input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </Field>

              <Field data-invalid={error === null ? undefined : true}>
                <FieldLabel htmlFor="password">Password</FieldLabel>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  aria-invalid={error === null ? undefined : true}
                />
                {error !== null && <FieldError role="alert">{error}</FieldError>}
              </Field>

              <Button type="submit" className="w-full" disabled={busy}>
                {busy ? 'Signing in…' : 'Sign in'}
              </Button>
            </form>
          </CardContent>
        </Card>

        <p className="text-muted-foreground text-center text-sm">
          No account?{' '}
          <Link href="/sign-up" className="text-foreground underline underline-offset-4">
            Create one
          </Link>
          .
        </p>
      </div>
    </main>
  );
}
