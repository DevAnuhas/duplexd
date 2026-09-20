import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

const STATE_STYLES: Record<string, string> = {
  starting:
    'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  active:
    'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  ended: 'border-border bg-secondary text-secondary-foreground',
  incomplete:
    'border-orange-500/25 bg-orange-500/10 text-orange-700 dark:text-orange-300',
  failed:
    'border-destructive/25 bg-destructive/10 text-destructive dark:text-red-300',
};

export function CallStateBadge({ state }: { state: string }) {
  return (
    <Badge variant="outline" className={cn('capitalize', STATE_STYLES[state])}>
      {state}
    </Badge>
  );
}
