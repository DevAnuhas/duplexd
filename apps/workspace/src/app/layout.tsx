import type { ReactNode } from 'react';

export const metadata = {
  title: 'duplexd workspace',
  description: 'Assistants, API keys, and calls.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
