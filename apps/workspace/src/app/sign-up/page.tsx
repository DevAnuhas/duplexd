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
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { authClient } from '@/lib/auth-client';

export default function SignUpPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const result = await authClient.signUp.email({
      email,
      password,
      name: email,
    });

    setBusy(false);

    if (result.error) {
      // The email stays in state on purpose. A form that clears itself on a
      // validation error makes the user retype everything, which is a
      // correctness problem wearing a design costume.
      setError('Could not create that account. Check the details and retry.');
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
            <CardTitle>Create an account</CardTitle>
            <CardDescription>
              This creates your organization. You can rename it in Settings
              afterwards.
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
                {/*
                  Signup names the account after this address, so say so here
                  rather than letting the tenant discover it in the sidebar.
                */}
                <FieldDescription>
                  Your organization starts out named after this address.
                </FieldDescription>
              </Field>

              <Field data-invalid={error === null ? undefined : true}>
                <FieldLabel htmlFor="password">Password</FieldLabel>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={8}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  aria-invalid={error === null ? undefined : true}
                />
                <FieldDescription>At least 8 characters.</FieldDescription>
                {error !== null && <FieldError role="alert">{error}</FieldError>}
              </Field>

              <Button type="submit" className="w-full" disabled={busy}>
                {busy ? 'Creating account…' : 'Create account'}
              </Button>
            </form>
          </CardContent>
        </Card>

        <p className="text-muted-foreground text-center text-sm">
          Already have one?{' '}
          <Link href="/sign-in" className="text-foreground underline underline-offset-4">
            Sign in
          </Link>
          .
        </p>
      </div>
    </main>
  );
}
