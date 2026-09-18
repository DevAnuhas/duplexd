'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

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
    <main>
      <h1>Create an account</h1>
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
          autoComplete="new-password"
          required
          minLength={8}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />

        {error !== null && <p role="alert">{error}</p>}

        <button type="submit" disabled={busy}>
          Create account
        </button>
      </form>
      <p>
        Already have one? <Link href="/sign-in">Sign in</Link>.
      </p>
    </main>
  );
}
