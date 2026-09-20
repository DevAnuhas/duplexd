'use client';

import { Copy } from '@phosphor-icons/react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

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
      toast.success(successLabel);
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
      size={compact ? 'icon' : 'default'}
      className={cn('h-11', compact && 'w-11')}
      onClick={copy}
      aria-label={label}
    >
      <Copy aria-hidden="true" data-icon="inline-start" />
      {!compact && <span>{label}</span>}
    </Button>
  );
}
