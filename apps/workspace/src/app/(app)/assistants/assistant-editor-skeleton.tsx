import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

const sections = [
  ['identity', 'Identity'],
  ['conversation', 'Conversation'],
  ['waiting', 'While waiting'],
  ['backend', 'Backend & connection'],
  ['tool-settings', 'Tools'],
] as const;

/** Static editor frame while session-scoped configuration streams in. */
export function AssistantEditorSkeleton() {
  return (
    <div
      className="flex flex-col gap-6"
      aria-label="Loading assistant"
      aria-busy="true"
    >
      <header className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-3">
          <Skeleton className="h-9 w-56" />
          <Skeleton className="h-5 w-72" />
        </div>
        <Skeleton className="h-9 w-28" />
      </header>
      <nav
        aria-label="Assistant sections"
        className="sticky top-0 z-10 flex min-w-0 flex-wrap gap-1 border-b bg-background py-3"
      >
        {sections.map(([id, label]) => (
          <Button key={id} variant="ghost" className="min-h-11" asChild>
            <a href={`#${id}`}>{label}</a>
          </Button>
        ))}
      </nav>
      {sections.map(([id, label]) => (
        <Card key={id} id={id} className="rounded-lg shadow-none">
          <CardHeader>
            <CardTitle>{label}</CardTitle>
          </CardHeader>
          <CardContent>
            <Skeleton
              className={id === 'conversation' ? 'h-48 w-full' : 'h-24 w-full'}
            />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
