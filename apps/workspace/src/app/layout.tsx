import type { ReactNode } from 'react';
import { Plus_Jakarta_Sans } from 'next/font/google';

import { ThemeProvider } from '@/components/theme-provider';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';

import './globals.css';

/**
 * Plus Jakarta Sans, the product's one typeface.
 *
 * `next/font/google` rather than a local file: the family is fetched and
 * self-hosted at build time, so there is still no request to Google at
 * runtime, and no font binaries in the repository.
 *
 * **History, so nobody re-does the work that isn't here.** This replaced
 * Founders Grotesk, whose vertical metrics were the cause of the off-centre
 * text in fixed-height controls — buttons, inputs, badges. Jakarta sits
 * correctly in the em box, so the face *was* the fix: there is deliberately
 * no per-primitive line-height or vertical-trim correction anywhere in the
 * codebase, and none should be added on the strength of that old symptom.
 */
const jakarta = Plus_Jakarta_Sans({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600', '700'],
  style: ['normal', 'italic'],
  variable: '--font-sans',
  display: 'swap',
});

export const metadata = {
  title: 'duplexd workspace',
  description: 'Assistants, API keys, and calls.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${jakarta.variable} font-sans`}>
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          <TooltipProvider>{children}</TooltipProvider>
          {/*
            Mounted once, at the root, so a toast raised anywhere has somewhere
            to land. Without it `toast()` is a silent no-op — which is exactly
            the failure the copy button's error path exists to avoid.

            Top-center, deliberately: results belong where the eye already is.
            It also survives client navigation — the reset-password flow
            raises a toast and then pushes to /sign-in, and this sits above
            both pages so the transition does not unmount it.
          */}
          <Toaster position="top-center" />
        </ThemeProvider>
      </body>
    </html>
  );
}
