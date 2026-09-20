'use client';

import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

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

  /**
   * `navigator.clipboard` is not always there, and `writeText` can reject.
   *
   * It is undefined outside a secure context and rejects when the browser
   * withholds permission or the document is not focused. Unhandled, the button
   * does nothing at all — no copy, no message, no error the customer can see —
   * which is a dead button in the one place it hurts most: the account id and
   * the one-time API key reveal are things a tenant *cannot retype*, so a
   * silent failure sends them away believing they have a value they do not.
   *
   * Saying so is the whole fix. The value is on the page either way, so the
   * fallback is selecting it by hand.
   */
  async function copy() {
    try {
      if (navigator.clipboard === undefined) {
        throw new Error('The clipboard is unavailable in this context.');
      }

      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      toast.error('Could not copy', {
        description: 'Your browser blocked clipboard access — select the value and copy it by hand.',
      });
    }
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
