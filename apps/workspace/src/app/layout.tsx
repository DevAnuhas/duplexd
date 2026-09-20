import type { ReactNode } from 'react';
import localFont from 'next/font/local';

import { ThemeProvider } from '@/components/theme-provider';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';

import './globals.css';

const foundersGrotesk = localFont({
  src: [
    { path: '../fonts/FoundersGrotesk-Light.otf', weight: '300', style: 'normal' },
    { path: '../fonts/FoundersGrotesk-LightItalic.otf', weight: '300', style: 'italic' },
    { path: '../fonts/FoundersGrotesk-Regular.otf', weight: '400', style: 'normal' },
    { path: '../fonts/FoundersGrotesk-RegularItalic.otf', weight: '400', style: 'italic' },
    { path: '../fonts/FoundersGrotesk-Medium.otf', weight: '500', style: 'normal' },
    { path: '../fonts/FoundersGrotesk-MediumItalic.otf', weight: '500', style: 'italic' },
    { path: '../fonts/FoundersGrotesk-Semibold.otf', weight: '600', style: 'normal' },
    { path: '../fonts/FoundersGrotesk-SemiboldItalic.otf', weight: '600', style: 'italic' },
    { path: '../fonts/FoundersGrotesk-Bold.otf', weight: '700', style: 'normal' },
    { path: '../fonts/FoundersGrotesk-BoldItalic.otf', weight: '700', style: 'italic' },
  ],
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
      <body className={`${foundersGrotesk.variable} font-sans`}>
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
