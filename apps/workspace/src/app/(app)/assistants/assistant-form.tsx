'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { CaretDown, Copy, SpinnerGap } from '@phosphor-icons/react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import {
  Controller,
  useForm,
  useWatch,
  type Control,
  type FieldErrors,
} from 'react-hook-form';
import { toast } from 'sonner';

import type { ActionResult } from '@/app/actions';
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
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
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
import {
  assistantSchema,
  type AssistantFormInput,
} from '@/lib/assistant-schema';
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

type TextFieldName = Exclude<
  keyof AssistantFormInput,
  'clearServerSecret' | 'tools'
>;

/** One Controller/Field composition for the editor's ordinary text controls. */
function AssistantTextField({
  control,
  name,
  label,
  description,
  rows,
  type = 'text',
  placeholder,
}: {
  control: Control<AssistantFormInput>;
  name: TextFieldName;
  label: string;
  description?: string;
  rows?: number;
  type?: 'text' | 'password';
  placeholder?: string;
}) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <Field data-invalid={fieldState.invalid}>
          <FieldLabel htmlFor={field.name}>{label}</FieldLabel>
          {description && (
            <FieldDescription id={`${field.name}-help`}>
              {description}
            </FieldDescription>
          )}
          {rows === undefined ? (
            <Input
              {...field}
              id={field.name}
              type={type}
              placeholder={placeholder}
              autoComplete={type === 'password' ? 'new-password' : undefined}
              className="min-h-11"
              aria-invalid={fieldState.invalid}
              aria-describedby={
                [
                  description ? `${field.name}-help` : '',
                  fieldState.invalid ? `${field.name}-error` : '',
                ]
                  .filter(Boolean)
                  .join(' ') || undefined
              }
            />
          ) : (
            <Textarea
              {...field}
              id={field.name}
              rows={rows}
              className={
                rows >= 6
                  ? 'min-h-40 leading-relaxed'
                  : 'min-h-24 leading-relaxed'
              }
              aria-invalid={fieldState.invalid}
              aria-describedby={
                [
                  description ? `${field.name}-help` : '',
                  fieldState.invalid ? `${field.name}-error` : '',
                ]
                  .filter(Boolean)
                  .join(' ') || undefined
              }
            />
          )}
          <FieldError id={`${field.name}-error`} errors={[fieldState.error]} />
        </Field>
      )}
    />
  );
}

/**
 * RHF owns every editable value. A failed write never resets the form; a
 * successful write resets to the submitted values with only the credential
 * entry and explicit clear instruction removed. Collapsed tools stay mounted.
 */
export function AssistantForm({
  values,
  action,
  submitLabel,
}: {
  values: AssistantFormValues;
  action: (formData: FormData) => Promise<ActionResult>;
  submitLabel: string;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [hasSecret, setHasSecret] = useState(values.hasServerSecret === true);
  const [toolsOpen, setToolsOpen] = useState(false);
  const form = useForm<AssistantFormInput>({
    resolver: zodResolver(assistantSchema),
    defaultValues: {
      name: values.name ?? '',
      instructions: values.instructions ?? '',
      voice: values.voice ?? '',
      accentStyle: values.accentStyle ?? '',
      waitingBehavior: values.waitingBehavior ?? '',
      backendModel: values.backendModel ?? '',
      backendInstructions: values.backendInstructions ?? '',
      serverUrl: values.serverUrl ?? '',
      serverSecret: '',
      clearServerSecret: false,
      tools: JSON.stringify(values.tools ?? [], null, 2),
    },
    shouldFocusError: false,
  });
  const title =
    useWatch({ control: form.control, name: 'name' }) || 'New assistant';
  const [toolsSummary, setToolsSummary] = useState(() =>
    summarizeTools(form.getValues('tools')),
  );
  const { isDirty, isSubmitting } = form.formState;

  function focusError(name: keyof AssistantFormInput) {
    if (name === 'tools') setToolsOpen(true);
    requestAnimationFrame(() => form.setFocus(name));
  }

  function invalid(errors: FieldErrors<AssistantFormInput>) {
    const first = Object.keys(errors).find(
      (name) => name in assistantSchema.shape,
    );
    if (first !== undefined) focusError(first as keyof AssistantFormInput);
    toast.error('This assistant was not saved. Check the highlighted fields.');
  }

  function reject(issues: ValidationIssue[]) {
    for (const name of new Set(issues.map((issue) => issue.field))) {
      const message = issues
        .filter((issue) => issue.field === name)
        .map((issue) => issue.message)
        .join(' ');
      if (name in assistantSchema.shape) {
        form.setError(name as keyof AssistantFormInput, {
          type: 'server',
          message,
        });
      } else {
        form.setError('root.server', { message });
      }
    }
    const first = issues.find((issue) => issue.field in assistantSchema.shape);
    if (first) focusError(first.field as keyof AssistantFormInput);
    toast.error('This assistant was not saved.', {
      description: issues.map((issue) => issue.message).join(' '),
    });
  }

  async function submit(input: AssistantFormInput) {
    const data = new FormData();
    for (const [name, value] of Object.entries(input)) {
      if (name === 'clearServerSecret') {
        if (value === true) data.set(name, 'on');
      } else if (typeof value === 'string') {
        data.set(name, value);
      }
    }
    setToolsSummary(summarizeTools(input.tools));
    form.clearErrors();
    // Keep the server mutation in React's transition context while returning a
    // promise to RHF so isSubmitting covers the whole request.
    await new Promise<void>((resolve) => {
      startTransition(async () => {
        try {
          const result = await action(data);
          if (!result.ok) {
            reject(result.issues);
            return;
          }
          if (input.serverSecret.trim() !== '') setHasSecret(true);
          else if (input.clearServerSecret) setHasSecret(false);
          form.reset({ ...input, serverSecret: '', clearServerSecret: false });
          toast.success('Saved');
          if (values.id === undefined && result.assistantId !== undefined) {
            router.replace(`/assistants/${result.assistantId}`);
          }
          router.refresh();
        } catch {
          const message =
            'Could not confirm the save. Your edits are still here. Try again or refresh to check the saved version.';
          form.setError('root.server', { message });
          toast.error(message);
        } finally {
          resolve();
        }
      });
    });
  }

  async function copyId() {
    if (values.id === undefined) return;
    try {
      await navigator.clipboard.writeText(values.id);
      toast.success('Assistant ID copied');
    } catch {
      toast.error('Could not copy. Select the ID to copy it.');
    }
  }

  return (
    <form
      noValidate
      onSubmit={form.handleSubmit(submit, invalid)}
      className="flex min-w-0 flex-col gap-6"
    >
      <header className="flex min-w-0 flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <Link
            href="/assistants"
            className="inline-flex min-h-11 w-fit items-center rounded-sm text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring"
          >
            Assistants
          </Link>
          <h1 className="break-words text-3xl font-semibold tracking-tight">
            {title}
          </h1>
          {values.id !== undefined ? (
            <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span className="break-all tabular-nums">{values.id}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-11"
                onClick={copyId}
                aria-label="Copy assistant ID"
              >
                <Copy weight="regular" className="size-4" aria-hidden="true" />
              </Button>
            </div>
          ) : (
            <p className="text-muted-foreground">
              Give your assistant a voice and connect it to your backend.
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span role="status" className="text-sm text-muted-foreground">
            {isSubmitting ? 'Saving…' : isDirty ? 'Unsaved changes' : ''}
          </span>
          <Button type="submit" disabled={isSubmitting} className="min-h-11">
            {isSubmitting && (
              <SpinnerGap
                weight="regular"
                data-icon="inline-start"
                className="size-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            )}
            {isSubmitting ? 'Saving…' : submitLabel}
          </Button>
        </div>
      </header>

      <nav
        aria-label="Assistant sections"
        className="sticky top-0 z-10 flex min-w-0 flex-wrap gap-1 border-b bg-background/95 py-3 backdrop-blur-sm"
      >
        {sections.map(([id, label]) => (
          <Button key={id} asChild variant="ghost" className="min-h-11">
            <a href={`#${id}`}>{label}</a>
          </Button>
        ))}
      </nav>

      <FieldSet disabled={isSubmitting} className="min-w-0">
        <FieldLegend className="sr-only">Assistant configuration</FieldLegend>
        <Card id="identity" className="scroll-mt-40 rounded-lg shadow-none">
          <CardHeader>
            <CardTitle>
              <h2>Identity</h2>
            </CardTitle>
            <CardDescription>
              A name you can recognize in your call history.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <AssistantTextField
              control={form.control}
              name="name"
              label="Assistant name"
            />
          </CardContent>
        </Card>
        <Card id="conversation" className="scroll-mt-40 rounded-lg shadow-none">
          <CardHeader>
            <CardTitle>
              <h2>Conversation</h2>
            </CardTitle>
            <CardDescription>
              Shape how the assistant speaks with callers.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <AssistantTextField
                control={form.control}
                name="instructions"
                label="Conversation instructions"
                rows={8}
              />
              <FieldGroup className="grid gap-6 sm:grid-cols-2">
                <AssistantTextField
                  control={form.control}
                  name="voice"
                  label="Voice"
                  description="The voice identifier used for your calls."
                />
                <AssistantTextField
                  control={form.control}
                  name="accentStyle"
                  label="Accent & speaking style"
                  description="Describe the accent, tone, and pace."
                />
              </FieldGroup>
            </FieldGroup>
          </CardContent>
        </Card>
        <Card id="waiting" className="scroll-mt-40 rounded-lg shadow-none">
          <CardHeader>
            <CardTitle>
              <h2>While waiting</h2>
            </CardTitle>
            <CardDescription>
              What should it say while waiting for an answer?
            </CardDescription>
          </CardHeader>
          <CardContent>
            <AssistantTextField
              control={form.control}
              name="waitingBehavior"
              label="Waiting behavior"
              rows={3}
            />
          </CardContent>
        </Card>
        <Card id="backend" className="scroll-mt-40 rounded-lg shadow-none">
          <CardHeader>
            <CardTitle>
              <h2>Backend & connection</h2>
            </CardTitle>
            <CardDescription>
              Connect the assistant to the actions your backend provides.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <AssistantTextField
                control={form.control}
                name="backendModel"
                label="Backend model"
              />
              <AssistantTextField
                control={form.control}
                name="backendInstructions"
                label="Backend instructions"
                rows={6}
                description="Guide how tools are chosen. Your backend still controls permissions and confirms actions."
              />
              <AssistantTextField
                control={form.control}
                name="serverUrl"
                label="Server URL"
                placeholder="https://api.example.com/voice"
                description="Tool requests are sent to this endpoint."
              />
              <Separator />
              <FieldSet className="gap-4">
                <FieldLegend className="mb-0 flex w-full flex-wrap items-center justify-between gap-2">
                  Webhook secret{' '}
                  <Badge variant="outline">
                    {hasSecret ? 'Configured' : 'Not configured'}
                  </Badge>
                </FieldLegend>
                <FieldDescription data-testid="secret-state">
                  {hasSecret
                    ? "A secret is set. It can't be shown — enter a new one to replace it."
                    : 'No secret is set.'}
                </FieldDescription>
                <AssistantTextField
                  control={form.control}
                  name="serverSecret"
                  label={hasSecret ? 'Replace secret' : 'New secret'}
                  type="password"
                  description="Leave blank to keep the current secret."
                />
                {hasSecret && (
                  <Controller
                    control={form.control}
                    name="clearServerSecret"
                    render={({ field, fieldState }) => (
                      <Field
                        orientation="horizontal"
                        data-invalid={fieldState.invalid}
                      >
                        <Checkbox
                          ref={field.ref}
                          id={field.name}
                          name={field.name}
                          value="on"
                          checked={field.value}
                          onCheckedChange={(checked) =>
                            field.onChange(checked === true)
                          }
                          onBlur={field.onBlur}
                          aria-invalid={fieldState.invalid}
                          aria-describedby="clearServerSecret-help clearServerSecret-error"
                          className="size-11"
                        />
                        <div className="flex min-w-0 flex-col gap-1">
                          <FieldLabel htmlFor={field.name}>
                            Remove the stored secret when saving
                          </FieldLabel>
                          <FieldDescription id="clearServerSecret-help">
                            This takes effect only after a successful save.
                          </FieldDescription>
                          <FieldError
                            id="clearServerSecret-error"
                            errors={[fieldState.error]}
                          />
                        </div>
                      </Field>
                    )}
                  />
                )}
              </FieldSet>
            </FieldGroup>
          </CardContent>
        </Card>
        <Card
          id="tool-settings"
          className="min-w-0 scroll-mt-40 rounded-lg shadow-none"
        >
          <CardHeader>
            <CardTitle>
              <h2>Tools</h2>
            </CardTitle>
            <CardDescription>
              Actions available through your backend. Changes take effect when
              you save.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex min-w-0 flex-col gap-5">
            {toolsSummary.ok ? (
              toolsSummary.rows.length === 0 ? (
                <FieldDescription>
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
              <FieldDescription>
                Tool summary unavailable. Check the JSON editor below.
              </FieldDescription>
            )}
            <Collapsible open={toolsOpen} onOpenChange={setToolsOpen}>
              <CollapsibleTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  className="group min-h-11"
                >
                  Edit as JSON{' '}
                  <CaretDown
                    weight="regular"
                    data-icon="inline-end"
                    className="size-4 group-data-[state=open]:rotate-180"
                    aria-hidden="true"
                  />
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent
                forceMount
                className="mt-4 data-[state=closed]:hidden"
              >
                <Controller
                  control={form.control}
                  name="tools"
                  render={({ field, fieldState }) => (
                    <Field data-invalid={fieldState.invalid}>
                      <FieldLabel htmlFor={field.name}>
                        Tool definitions
                      </FieldLabel>
                      <FieldDescription id="tools-help">
                        A JSON array of tools. Each entry has a name,
                        description, and parameters schema.
                      </FieldDescription>
                      <Textarea
                        {...field}
                        id={field.name}
                        rows={14}
                        className="min-h-64 leading-relaxed"
                        spellCheck={false}
                        onBlur={() => {
                          field.onBlur();
                          setToolsSummary(summarizeTools(field.value));
                          void form.trigger('tools');
                        }}
                        aria-invalid={fieldState.invalid}
                        aria-describedby={
                          fieldState.invalid
                            ? 'tools-help tools-error'
                            : 'tools-help'
                        }
                      />
                      <FieldError
                        id="tools-error"
                        errors={[fieldState.error]}
                      />
                    </Field>
                  )}
                />
              </CollapsibleContent>
            </Collapsible>
          </CardContent>
        </Card>
      </FieldSet>
    </form>
  );
}
