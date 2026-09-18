'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

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
    <main>
      <h1>Sign in</h1>
      <form onSubmit={onSubmit}>
        <label htmlFor="email">Email</label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />

        <label htmlFor="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />

        {error !== null && <p role="alert">{error}</p>}

        <button type="submit" disabled={busy}>
          Sign in
        </button>
      </form>
      <p>
        No account? <Link href="/sign-up">Create one</Link>.
      </p>
    </main>
  );
}
