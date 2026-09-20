import Link from 'next/link';

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

import { SignUpForm } from './sign-up-form';

/** Create an account. Static, outside the `(app)` group — see `/sign-in`. */
export default function SignUpPage() {
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
            <SignUpForm />
          </CardContent>
        </Card>

        <p className="text-muted-foreground text-center text-sm">
          Already have one?{' '}
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
  );
}
