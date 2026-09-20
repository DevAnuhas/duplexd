'use client';

import { Check, ChevronDown, Copy, LoaderCircle } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  useEffect,
  useRef,
  useState,
  useTransition,
  type FormEvent,
} from 'react';

import type { ActionResult } from '@/app/actions';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import {
  Field,
  FieldDescription,
  FieldError as ErrorMessage,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field';
import { Separator } from '@/components/ui/separator';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { summarizeTools } from '@/lib/tools-summary';
import type { ValidationIssue } from '@/lib/validate';

export type AssistantFormValues = {
  id?: string;
  name?: string | null;
  voice?: string | null;
  accentStyle?: string | null;
  instructions?: string | null;
  backendInstructions?: string | null;
  backendModel?: string | null;
  waitingBehavior?: string | null;
  serverUrl?: string | null;
  tools?: unknown;
  hasServerSecret?: boolean;
};

const sections = [
  ['identity', 'Identity'],
  ['conversation', 'Conversation'],
  ['waiting', 'While waiting'],
  ['backend', 'Backend & connection'],
  ['tool-settings', 'Tools'],
] as const;

function FieldError({
  field,
  issues,
}: {
  field: string;
  issues: ValidationIssue[];
}) {
  const messages = issues.filter((issue) => issue.field === field);
  if (messages.length === 0) return null;
  return (
    <ErrorMessage id={`${field}-error`}>
      {messages.map((issue) => issue.message).join(' ')}
    </ErrorMessage>
  );
}

/**
 * Every control stays mounted, including the collapsed JSON editor. Fields are
 * uncontrolled so rejecting a save never replaces what the operator typed.
 * JSON is summarized but never rewritten: FormData reads the textarea itself.
 * Secrets arrive only through a new, initially empty password input.
 */
export function AssistantForm({
  values,
  action,
  submitLabel,
  initiallySaved = false,
}: {
  values: AssistantFormValues;
  action: (formData: FormData) => Promise<ActionResult>;
  submitLabel: string;
  initiallySaved?: boolean;
}) {
  const router = useRouter();
  const secretRef = useRef<HTMLInputElement>(null);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(initiallySaved);
  const [title, setTitle] = useState(values.name || 'New assistant');
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>(
    'idle',
  );
  const [hasSecret, setHasSecret] = useState(values.hasServerSecret === true);
  const [clearSecret, setClearSecret] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [initialTools] = useState(() =>
    JSON.stringify(values.tools ?? [], null, 2),
  );
  const [toolsSummary, setToolsSummary] = useState(() =>
    summarizeTools(initialTools),
  );
  const [, startTransition] = useTransition();

  useEffect(() => {
    if (issues.length === 0) return;
    const first = issues[0];
    if (first === undefined) return;
    const frame = requestAnimationFrame(() =>
      document.getElementById(first.field)?.focus(),
    );
    return () => cancelAnimationFrame(frame);
  }, [issues]);

  function markDirty() {
    setDirty(true);
    setSaved(false);
  }

  function reject(nextIssues: ValidationIssue[]) {
    setIssues(nextIssues);
    if (nextIssues.some((issue) => issue.field === 'tools')) setToolsOpen(true);
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    // Read before disabling controls, which would omit them from FormData.
    const data = new FormData(event.currentTarget);
    const summary = summarizeTools(String(data.get('tools') ?? ''));
    setToolsSummary(summary);
    if (!summary.ok) {
      reject([{ field: 'tools', message: summary.error }]);
      return;
    }
    setBusy(true);
    setIssues([]);
    startTransition(async () => {
      try {
        const result = await action(data);
        if (!result.ok) {
          reject(result.issues);
          return;
        }
        // A successful write is the only point where the entered credential
        // is cleared. Rejections leave it and every other field untouched.
        const replacement = data.get('serverSecret');
        if (typeof replacement === 'string' && replacement.trim() !== '')
          setHasSecret(true);
        else if (data.get('clearServerSecret') === 'on') setHasSecret(false);
        if (secretRef.current !== null) secretRef.current.value = '';
        setClearSecret(false);
        setDirty(false);
        setSaved(true);
        if (values.id === undefined && result.assistantId !== undefined) {
          router.replace(`/assistants/${result.assistantId}?saved=1`);
        }
        router.refresh();
      } catch {
        reject([
          {
            field: 'name',
            message:
              'Could not confirm the save. Your edits are still here. Try again or refresh to check the saved version.',
          },
        ]);
      } finally {
        setBusy(false);
      }
    });
  }

  function fieldState(field: string) {
    const invalid = issues.some((issue) => issue.field === field);
    return {
      'aria-invalid': invalid,
      'aria-describedby': invalid ? `${field}-error` : undefined,
    };
  }

  async function copyId() {
    if (values.id === undefined) return;
    try {
      await navigator.clipboard.writeText(values.id);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  }

  return (
    <form
      method="post"
      onSubmit={onSubmit}
      onChange={markDirty}
      className="flex flex-col gap-6"
    >
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1 flex flex-col gap-2">
          <Link
            href="/assistants"
            className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            Assistants
          </Link>
          <h1 className="break-words text-3xl font-semibold tracking-tight">
            {title}
          </h1>
          {values.id !== undefined ? (
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span className="break-all tabular-nums">{values.id}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={copyId}
                aria-label="Copy assistant ID"
              >
                {copyState === 'copied' ? (
                  <Check aria-hidden="true" />
                ) : (
                  <Copy aria-hidden="true" />
                )}
              </Button>
              <span role="status">
                {copyState === 'copied'
                  ? 'Copied'
                  : copyState === 'failed'
                    ? 'Could not copy. Select the ID to copy it.'
                    : ''}
              </span>
            </div>
          ) : (
            <p className="text-muted-foreground">
              Give your assistant a voice and connect it to your backend.
            </p>
          )}
        </div>
        <div className="flex items-center gap-3">
          <span role="status" className="text-sm text-muted-foreground">
            {busy
              ? 'Saving…'
              : dirty
                ? 'Unsaved changes'
                : saved
                  ? 'Saved'
                  : ''}
          </span>
          <Button type="submit" disabled={busy}>
            {busy && (
              <LoaderCircle
                data-icon="inline-start"
                className="animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            )}
            {busy ? 'Saving…' : submitLabel}
          </Button>
        </div>
      </header>

      <nav
        aria-label="Assistant sections"
        className="sticky top-0 z-10 -mx-1 flex gap-1 overflow-x-auto border-b bg-background/95 px-1 py-3 backdrop-blur-sm"
      >
        {sections.map(([id, label]) => (
          <Button key={id} asChild variant="ghost" size="sm">
            <a href={`#${id}`}>{label}</a>
          </Button>
        ))}
      </nav>

      {issues.length > 0 && (
        <Alert variant="destructive">
          <AlertTitle>This assistant was not saved</AlertTitle>
          <AlertDescription>
            <ul className="list-disc flex flex-col gap-1 pl-4">
              {issues.map((issue, index) => (
                <li key={index}>{issue.message}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      <FieldSet disabled={busy} className="min-w-0">
        <FieldLegend className="sr-only">Assistant configuration</FieldLegend>
        <Card id="identity" className="scroll-mt-24 rounded-lg shadow-none">
          <CardHeader>
            <CardTitle>Identity</CardTitle>
            <CardDescription>
              A name you can recognize in your call history.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <Field
              data-invalid={issues.some((issue) => issue.field === 'name')}
            >
              <FieldLabel htmlFor="name">Assistant name</FieldLabel>
              <Input
                id="name"
                name="name"
                defaultValue={values.name ?? ''}
                required
                onChange={(event) =>
                  setTitle(event.target.value || 'New assistant')
                }
                {...fieldState('name')}
              />
              <FieldError field="name" issues={issues} />
            </Field>
          </CardContent>
        </Card>

        <Card id="conversation" className="scroll-mt-24 rounded-lg shadow-none">
          <CardHeader>
            <CardTitle>Conversation</CardTitle>
            <CardDescription>
              Shape how the assistant speaks with callers.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-6">
            <Field
              data-invalid={issues.some(
                (issue) => issue.field === 'instructions',
              )}
            >
              <FieldLabel htmlFor="instructions">
                Conversation instructions
              </FieldLabel>
              <Textarea
                id="instructions"
                name="instructions"
                rows={8}
                className="min-h-48 leading-relaxed"
                defaultValue={values.instructions ?? ''}
                {...fieldState('instructions')}
              />
              <FieldError field="instructions" issues={issues} />
            </Field>
            <FieldGroup className="grid gap-6 sm:grid-cols-2">
              <Field
                data-invalid={issues.some((issue) => issue.field === 'voice')}
              >
                <FieldLabel htmlFor="voice">Voice</FieldLabel>
                <Input
                  id="voice"
                  name="voice"
                  defaultValue={values.voice ?? ''}
                  {...fieldState('voice')}
                />
                <FieldDescription className="text-sm text-muted-foreground">
                  The voice identifier used for your calls.
                </FieldDescription>
                <FieldError field="voice" issues={issues} />
              </Field>
              <Field
                data-invalid={issues.some(
                  (issue) => issue.field === 'accentStyle',
                )}
              >
                <FieldLabel htmlFor="accentStyle">
                  Accent &amp; speaking style
                </FieldLabel>
                <Input
                  id="accentStyle"
                  name="accentStyle"
                  defaultValue={values.accentStyle ?? ''}
                  {...fieldState('accentStyle')}
                />
                <FieldDescription className="text-sm text-muted-foreground">
                  Describe the accent, tone, and pace.
                </FieldDescription>
                <FieldError field="accentStyle" issues={issues} />
              </Field>
            </FieldGroup>
          </CardContent>
        </Card>

        <Card id="waiting" className="scroll-mt-24 rounded-lg shadow-none">
          <CardHeader>
            <CardTitle>While waiting</CardTitle>
            <CardDescription>
              What should it say while waiting for an answer?
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <Field
              data-invalid={issues.some(
                (issue) => issue.field === 'waitingBehavior',
              )}
            >
              <FieldLabel htmlFor="waitingBehavior">
                Waiting behavior
              </FieldLabel>
              <Textarea
                id="waitingBehavior"
                name="waitingBehavior"
                rows={3}
                defaultValue={values.waitingBehavior ?? ''}
                {...fieldState('waitingBehavior')}
              />
              <FieldError field="waitingBehavior" issues={issues} />
            </Field>
          </CardContent>
        </Card>

        <Card id="backend" className="scroll-mt-24 rounded-lg shadow-none">
          <CardHeader>
            <CardTitle>Backend &amp; connection</CardTitle>
            <CardDescription>
              Connect the assistant to the actions your backend provides.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-6">
            <Field
              data-invalid={issues.some(
                (issue) => issue.field === 'backendModel',
              )}
            >
              <FieldLabel htmlFor="backendModel">Backend model</FieldLabel>
              <Input
                id="backendModel"
                name="backendModel"
                defaultValue={values.backendModel ?? ''}
                {...fieldState('backendModel')}
              />
              <FieldError field="backendModel" issues={issues} />
            </Field>
            <Field
              data-invalid={issues.some(
                (issue) => issue.field === 'backendInstructions',
              )}
            >
              <FieldLabel htmlFor="backendInstructions">
                Backend instructions
              </FieldLabel>
              <FieldDescription
                id="backend-instructions-help"
                className="text-sm text-muted-foreground"
              >
                Guide how tools are chosen. Your backend still controls
                permissions and confirms actions.
              </FieldDescription>
              <Textarea
                id="backendInstructions"
                name="backendInstructions"
                rows={6}
                className="min-h-36 leading-relaxed"
                defaultValue={values.backendInstructions ?? ''}
                {...fieldState('backendInstructions')}
                aria-describedby={
                  issues.some((issue) => issue.field === 'backendInstructions')
                    ? 'backend-instructions-help backendInstructions-error'
                    : 'backend-instructions-help'
                }
              />
              <FieldError field="backendInstructions" issues={issues} />
            </Field>
            <Field
              data-invalid={issues.some((issue) => issue.field === 'serverUrl')}
            >
              <FieldLabel htmlFor="serverUrl">Server URL</FieldLabel>
              <Input
                id="serverUrl"
                name="serverUrl"
                type="url"
                placeholder="https://api.example.com/voice"
                defaultValue={values.serverUrl ?? ''}
                {...fieldState('serverUrl')}
              />
              <FieldDescription className="text-sm text-muted-foreground">
                Tool requests are sent to this endpoint.
              </FieldDescription>
              <FieldError field="serverUrl" issues={issues} />
            </Field>
            <Separator />
            <FieldSet className="gap-4">
              <FieldLegend className="mb-0 flex w-full flex-wrap items-center justify-between gap-2">
                Webhook secret
                <Badge variant="outline">
                  {hasSecret ? 'Configured' : 'Not configured'}
                </Badge>
              </FieldLegend>
              <FieldDescription
                data-testid="secret-state"
                className="text-sm text-muted-foreground"
              >
                {hasSecret
                  ? "A secret is set. It can't be shown — enter a new one to replace it."
                  : 'No secret is set.'}
              </FieldDescription>
              <Field
                data-invalid={issues.some(
                  (issue) => issue.field === 'serverSecret',
                )}
              >
                <FieldLabel htmlFor="serverSecret">
                  {hasSecret ? 'Replace secret' : 'New secret'}
                </FieldLabel>
                <Input
                  ref={secretRef}
                  id="serverSecret"
                  name="serverSecret"
                  type="password"
                  autoComplete="new-password"
                  defaultValue=""
                  {...fieldState('serverSecret')}
                />
                <FieldDescription className="text-sm text-muted-foreground">
                  Leave blank to keep the current secret.
                </FieldDescription>
                <FieldError field="serverSecret" issues={issues} />
              </Field>
              {hasSecret && (
                <Field orientation="horizontal">
                  <Checkbox
                    id="clearServerSecret"
                    name="clearServerSecret"
                    value="on"
                    checked={clearSecret}
                    onCheckedChange={(checked) => {
                      setClearSecret(checked === true);
                      markDirty();
                    }}
                  />
                  <FieldLabel htmlFor="clearServerSecret">
                    Remove the stored secret when saving
                  </FieldLabel>
                </Field>
              )}
            </FieldSet>
          </CardContent>
        </Card>

        <Card
          id="tool-settings"
          className="scroll-mt-24 rounded-lg shadow-none"
        >
          <CardHeader>
            <CardTitle>Tools</CardTitle>
            <CardDescription>
              Actions available through your backend. Changes take effect when
              you save.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            {toolsSummary.ok ? (
              toolsSummary.rows.length === 0 ? (
                <FieldDescription className="text-sm text-muted-foreground">
                  No tools configured. Open the JSON editor to add your
                  backend's tool definitions.
                </FieldDescription>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Description</TableHead>
                      <TableHead className="text-right">Parameters</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {toolsSummary.rows.map((tool, index) => (
                      <TableRow key={index}>
                        <TableCell className="max-w-48 break-words whitespace-normal font-medium">
                          {tool.name}
                        </TableCell>
                        <TableCell className="max-w-lg whitespace-normal text-muted-foreground">
                          {tool.description}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {tool.parameterCount}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )
            ) : (
              <Alert variant="destructive">
                <AlertDescription>{toolsSummary.error}</AlertDescription>
              </Alert>
            )}
            <Collapsible open={toolsOpen} onOpenChange={setToolsOpen}>
              <CollapsibleTrigger asChild>
                <Button type="button" variant="outline" className="group">
                  Edit as JSON{' '}
                  <ChevronDown
                    data-icon="inline-end"
                    className="group-data-[state=open]:rotate-180"
                    aria-hidden="true"
                  />
                </Button>
              </CollapsibleTrigger>
              {/* forceMount is essential: closed tools must still be in FormData. */}
              <CollapsibleContent
                forceMount
                className="mt-4 flex flex-col gap-2 data-[state=closed]:hidden"
              >
                <Field
                  data-invalid={
                    !toolsSummary.ok ||
                    issues.some((issue) => issue.field === 'tools')
                  }
                >
                  <FieldLabel htmlFor="tools">Tool definitions</FieldLabel>
                  <FieldDescription
                    id="tools-help"
                    className="text-sm text-muted-foreground"
                  >
                    A JSON array of tools. Each entry has a name, description,
                    and parameters schema.
                  </FieldDescription>
                  <Textarea
                    id="tools"
                    name="tools"
                    rows={14}
                    className="min-h-64 leading-relaxed"
                    defaultValue={initialTools}
                    spellCheck={false}
                    onBlur={(event) =>
                      setToolsSummary(summarizeTools(event.target.value))
                    }
                    aria-invalid={
                      !toolsSummary.ok ||
                      issues.some((issue) => issue.field === 'tools')
                    }
                    aria-describedby={
                      !toolsSummary.ok ||
                      issues.some((issue) => issue.field === 'tools')
                        ? 'tools-help tools-error'
                        : 'tools-help'
                    }
                  />
                  <FieldError field="tools" issues={issues} />
                  {!toolsSummary.ok &&
                    !issues.some((issue) => issue.field === 'tools') && (
                      <ErrorMessage id="tools-error">
                        {toolsSummary.error}
                      </ErrorMessage>
                    )}
                </Field>
              </CollapsibleContent>
            </Collapsible>
          </CardContent>
        </Card>
      </FieldSet>
    </form>
  );
}
