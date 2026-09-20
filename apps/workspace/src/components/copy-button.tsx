'use client';

import { Check, Copy } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';

export function CopyButton({
  value,
  label = 'Copy',
  successLabel = 'Copied',
  compact = false,
}: {
  value: string;
  label?: string;
  successLabel?: string;
  compact?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2_000);
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size={compact ? 'icon-xs' : 'sm'}
      onClick={copy}
      aria-label={copied ? successLabel : label}
    >
      {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      {!compact && <span>{copied ? successLabel : label}</span>}
    </Button>
  );
}
