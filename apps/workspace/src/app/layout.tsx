import type { ReactNode } from 'react';
import localFont from 'next/font/local';

import { ThemeProvider } from '@/components/theme-provider';
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
        </ThemeProvider>
      </body>
    </html>
  );
}
