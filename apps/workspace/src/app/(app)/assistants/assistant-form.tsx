"use client"

import { zodResolver } from "@hookform/resolvers/zod"
import { CaretDown, Copy, SpinnerGap } from "@phosphor-icons/react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useEffect, useRef, useState, useTransition } from "react"
import {
  Controller,
  useForm,
  useWatch,
  type Control,
  type FieldErrors,
} from "react-hook-form"
import { toast } from "sonner"

import type { ActionResult } from "@/app/actions"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import {
  assistantSchema,
  type AssistantFormInput,
} from "@/lib/assistant-schema"
import { summarizeTools } from "@/lib/tools-summary"
import type { ValidationIssue } from "@/lib/validate"
import { useAssistantDraft, useOptionalAssistantDraft } from "./[id]/draft-host"
import { fieldsDirty, previewFields } from "@/sandbox/client/draft-store"
import { AssistantNavigation } from "./assistant-navigation"

export type AssistantFormValues = {
  id?: string
  name?: string | null
  voice?: string | null
  accentStyle?: string | null
  instructions?: string | null
  backendInstructions?: string | null
  backendModel?: string | null
  waitingBehavior?: string | null
  serverUrl?: string | null
  tools?: unknown
  hasServerSecret?: boolean
  revision?: number
}

const sections = [
  ["essentials", "Essentials"],
  ["instructions", "Instructions"],
  ["backend", "Connection"],
  ["tool-settings", "Tools"],
] as const

type TextFieldName = Exclude<
  keyof AssistantFormInput,
  "clearServerSecret" | "tools"
>

/** One Controller/Field composition for the editor's ordinary text controls. */
function AssistantTextField({
  control,
  name,
  label,
  description,
  rows,
  type = "text",
  placeholder,
}: {
  control: Control<AssistantFormInput>
  name: TextFieldName
  label: string
  description?: string
  rows?: number
  type?: "text" | "password"
  placeholder: string
}) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <Field data-invalid={fieldState.invalid} className="gap-1.5">
          <FieldLabel htmlFor={field.name}>{label}</FieldLabel>
          {description && (
            <FieldDescription id={`${field.name}-help`} className="text-xs">
              {description}
            </FieldDescription>
          )}
          {rows === undefined ? (
            <Input
              {...field}
              id={field.name}
              type={type}
              placeholder={placeholder}
              autoComplete={type === "password" ? "new-password" : undefined}
              className="h-9"
              aria-invalid={fieldState.invalid}
              aria-describedby={
                [
                  description ? `${field.name}-help` : "",
                  fieldState.invalid ? `${field.name}-error` : "",
                ]
                  .filter(Boolean)
                  .join(" ") || undefined
              }
            />
          ) : (
            <Textarea
              {...field}
              id={field.name}
              rows={rows}
              placeholder={placeholder}
              className={
                rows >= 6
                  ? "min-h-36 leading-relaxed"
                  : "min-h-20 leading-relaxed"
              }
              aria-invalid={fieldState.invalid}
              aria-describedby={
                [
                  description ? `${field.name}-help` : "",
                  fieldState.invalid ? `${field.name}-error` : "",
                ]
                  .filter(Boolean)
                  .join(" ") || undefined
              }
            />
          )}
          <FieldError id={`${field.name}-error`} errors={[fieldState.error]} />
        </Field>
      )}
    />
  )
}

/**
 * RHF owns every editable value. A failed write never resets the form; a
 * successful write resets to the submitted values with only the credential
 * entry and explicit clear instruction removed. Collapsed tools stay mounted.
 */
type AssistantFormProps = {
  values: AssistantFormValues
  action: (formData: FormData) => Promise<ActionResult>
  submitLabel: string
}
export function AssistantForm(props: AssistantFormProps) {
  const host = useOptionalAssistantDraft()
  return host === null ? (
    <AssistantFormEditor {...props} />
  ) : (
    <HostedAssistantForm {...props} />
  )
}
function HostedAssistantForm(props: AssistantFormProps) {
  const draft = useAssistantDraft()
  return <AssistantFormEditor {...props} draft={draft} />
}
function AssistantFormEditor({
  values,
  action,
  submitLabel,
  draft,
}: AssistantFormProps & { draft?: ReturnType<typeof useAssistantDraft> }) {
  const router = useRouter()
  const [, startTransition] = useTransition()
  const [hasSecret, setHasSecret] = useState(values.hasServerSecret === true)
  const [revision, setRevision] = useState(values.revision)
  const [toolsOpen, setToolsOpen] = useState(false)
  const [connectionOpen, setConnectionOpen] = useState(values.id === undefined)
  const form = useForm<AssistantFormInput>({
    resolver: zodResolver(assistantSchema),
    defaultValues: {
      name: values.name ?? "",
      instructions: values.instructions ?? "",
      voice: values.voice ?? "",
      accentStyle: values.accentStyle ?? "",
      waitingBehavior: values.waitingBehavior ?? "",
      backendModel: values.backendModel ?? "",
      backendInstructions: values.backendInstructions ?? "",
      serverUrl: values.serverUrl ?? "",
      serverSecret: "",
      clearServerSecret: false,
      tools: JSON.stringify(values.tools ?? [], null, 2),
      ...draft?.state.fields,
      ...(draft?.getEditorDraft() ?? {}),
    },
    shouldFocusError: false,
  })
  const title =
    useWatch({ control: form.control, name: "name" }) || "New assistant"
  const [toolsSummary, setToolsSummary] = useState(() =>
    summarizeTools(form.getValues("tools"))
  )
  const { isDirty, isSubmitting } = form.formState
  const resetFromHost = useRef(false)
  const epoch = draft?.state.formEpoch
  const store = draft?.store
  const getEditorDraft = draft?.getEditorDraft
  const setEditorDraft = draft?.setEditorDraft
  const clearEditorDraft = draft?.clearEditorDraft
  const editorBaseline = useRef({
    name: values.name ?? "",
    serverUrl: values.serverUrl ?? "",
  })
  editorBaseline.current = {
    name: values.name ?? "",
    serverUrl: values.serverUrl ?? "",
  }
  useEffect(() => {
    if (store === undefined) return
    const state = store.getSnapshot()
    const cached = getEditorDraft?.()
    resetFromHost.current = true
    form.reset({
      ...form.getValues(),
      ...state.fields,
      name: values.name ?? "",
      serverUrl: values.serverUrl ?? "",
      serverSecret: "",
      clearServerSecret: false,
      ...cached,
      ...(cached
        ? {
            serverSecret: form.getValues("serverSecret"),
            clearServerSecret: form.getValues("clearServerSecret"),
          }
        : {}),
    })
    resetFromHost.current = false
    setToolsSummary(summarizeTools(state.fields.tools))
  }, [epoch, store, form, values.name, values.serverUrl, getEditorDraft])
  useEffect(() => {
    if (store === undefined) return
    const subscription = form.watch(() => {
      if (resetFromHost.current) return
      const input = form.getValues()
      store.edit(input)
      setEditorDraft?.(input)
      store.setEditorOnlyDirty(
        input.name !== (values.name ?? "") ||
          input.serverUrl !== (values.serverUrl ?? "") ||
          input.serverSecret !== "" ||
          input.clearServerSecret
      )
    })
    return () => {
      subscription.unsubscribe()
    }
  }, [store, form, values.name, values.serverUrl, setEditorDraft])
  useEffect(
    () => () => {
      const cached = getEditorDraft?.()
      if (cached && store)
        store.setEditorOnlyDirty(
          cached.name !== editorBaseline.current.name ||
            cached.serverUrl !== editorBaseline.current.serverUrl
        )
    },
    [getEditorDraft, store]
  )
  const changes =
    isDirty ||
    (draft !== undefined &&
      (fieldsDirty(draft.state) || draft.state.editorOnlyDirty))
  const locked = draft?.locked === true
  const conflict =
    draft !== undefined &&
    (draft.state.assistantConflict !== null ||
      draft.state.sampleConflict !== null)

  function focusError(name: keyof AssistantFormInput) {
    if (name === "tools") setToolsOpen(true)
    requestAnimationFrame(() => form.setFocus(name))
  }

  function invalid(errors: FieldErrors<AssistantFormInput>) {
    const first = Object.keys(errors).find(
      (name) => name in assistantSchema.shape
    )
    if (first !== undefined) focusError(first as keyof AssistantFormInput)
    toast.error("This assistant was not saved. Check the highlighted fields.")
  }

  function reject(issues: ValidationIssue[]) {
    for (const name of new Set(issues.map((issue) => issue.field))) {
      const message = issues
        .filter((issue) => issue.field === name)
        .map((issue) => issue.message)
        .join(" ")
      if (name in assistantSchema.shape) {
        form.setError(name as keyof AssistantFormInput, {
          type: "server",
          message,
        })
      } else {
        form.setError("root.server", { message })
      }
    }
    const first = issues.find((issue) => issue.field in assistantSchema.shape)
    if (first) focusError(first.field as keyof AssistantFormInput)
    toast.error("This assistant was not saved.", {
      description: issues.map((issue) => issue.message).join(" "),
    })
  }

  async function submit(input: AssistantFormInput) {
    if (locked || conflict || store?.getSnapshot().saving) return
    store?.setSaving(true)
    const data = new FormData()
    const expectedRevision = draft?.state.baseRevision ?? revision
    if (expectedRevision !== undefined) {
      data.set("expectedRevision", String(expectedRevision))
    }
    for (const [name, value] of Object.entries(input)) {
      if (name === "clearServerSecret") {
        if (value === true) data.set(name, "on")
      } else if (typeof value === "string") {
        data.set(name, value)
      }
    }
    setToolsSummary(summarizeTools(input.tools))
    form.clearErrors()
    // Keep the server mutation in React's transition context while returning a
    // promise to RHF so isSubmitting covers the whole request.
    await new Promise<void>((resolve) => {
      startTransition(async () => {
        try {
          const result = await action(data)
          if (!result.ok) {
            if (result.currentRevision !== undefined) {
              store?.conflict("assistant", result.currentRevision)
              router.refresh()
            }
            reject(result.issues)
            return
          }
          if (input.serverSecret.trim() !== "") setHasSecret(true)
          else if (input.clearServerSecret) setHasSecret(false)
          if (result.revision !== undefined) {
            setRevision(result.revision)
            store?.savedAssistant(previewFields(input), result.revision)
            clearEditorDraft?.()
          }
          // The explicit save already established the new baseline. Do not
          // compare this reset with stale server props in the form watcher.
          resetFromHost.current = true
          form.reset({ ...input, serverSecret: "", clearServerSecret: false })
          resetFromHost.current = false
          toast.success("Saved")
          if (values.id === undefined && result.assistantId !== undefined) {
            router.replace(`/assistants/${result.assistantId}`)
          }
          router.refresh()
        } catch {
          const message =
            "Could not confirm the save. Your edits are still here. Try again or refresh to check the saved version."
          form.setError("root.server", { message })
          toast.error(message)
        } finally {
          store?.setSaving(false)
          resolve()
        }
      })
    })
  }

  async function copyId() {
    if (values.id === undefined) return
    try {
      await navigator.clipboard.writeText(values.id)
      toast.success("Assistant ID copied")
    } catch {
      toast.error("Could not copy. Select the ID to copy it.")
    }
  }

  return (
    <form
      noValidate
      onSubmit={form.handleSubmit(submit, invalid)}
      className="flex min-w-0 flex-col gap-4"
    >
      <header className="flex min-w-0 flex-wrap items-center justify-between gap-3 border-b pb-4">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <Link
            href="/assistants"
            className="inline-flex w-fit items-center rounded-sm text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring"
          >
            Assistants
          </Link>
          <h1 className="text-xl font-semibold tracking-tight break-words">
            {title}
          </h1>
          {values.id !== undefined ? (
            <div className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
              <span className="max-w-48 truncate tabular-nums">
                {values.id}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7"
                onClick={copyId}
                aria-label="Copy assistant ID"
              >
                <Copy weight="regular" className="size-4" aria-hidden="true" />
              </Button>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              Set up a voice assistant.
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span role="status" className="text-xs text-muted-foreground">
            {isSubmitting ? "Saving…" : changes ? "Unsaved changes" : ""}
          </span>
          <Button
            type="submit"
            disabled={isSubmitting || locked || conflict}
            className="h-9 px-4"
          >
            {isSubmitting && (
              <SpinnerGap
                weight="regular"
                data-icon="inline-start"
                className="size-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            )}
            {isSubmitting ? "Saving…" : submitLabel}
          </Button>
        </div>
      </header>

      {values.id !== undefined && (
        <AssistantNavigation assistantId={values.id} active="configure" />
      )}

      <nav
        aria-label="Assistant sections"
        className="flex min-w-0 flex-wrap gap-1 border-b pb-2"
      >
        {sections.map(([id, label]) => (
          <a
            key={id}
            href={`#${id}`}
            className="rounded-sm px-2 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          >
            {label}
          </a>
        ))}
      </nav>

      <FieldSet disabled={isSubmitting || locked} className="min-w-0 gap-4">
        <FieldLegend className="sr-only">Assistant configuration</FieldLegend>
        <Card
          id="essentials"
          className="scroll-mt-24 gap-3 rounded-lg py-4 shadow-none"
        >
          <CardHeader className="px-4">
            <CardTitle>
              <h2 className="text-sm">Assistant</h2>
            </CardTitle>
            <CardDescription className="text-xs">
              The settings that shape every call.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 px-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <AssistantTextField
              control={form.control}
              name="name"
              label="Name"
              placeholder="Support line"
            />
            <AssistantTextField
              control={form.control}
              name="backendModel"
              label="Backend model"
              placeholder="gpt-5.6-luna"
              description="OpenAI model ID. Practice currently supports gpt-5.6-luna."
            />
            <AssistantTextField
              control={form.control}
              name="voice"
              label="Voice"
              placeholder="marin"
              description="Provider voice ID."
            />
            <AssistantTextField
              control={form.control}
              name="accentStyle"
              label="Speaking style"
              placeholder="Calm, concise, friendly; US English"
              description="Tone, accent, and pace."
            />
          </CardContent>
        </Card>
        <Card
          id="instructions"
          className="scroll-mt-24 gap-3 rounded-lg py-4 shadow-none"
        >
          <CardHeader className="px-4">
            <CardTitle>
              <h2 className="text-sm">Instructions</h2>
            </CardTitle>
            <CardDescription className="text-xs">
              What the assistant says and how it handles requests.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 px-4">
            <AssistantTextField
              control={form.control}
              name="instructions"
              label="Conversation instructions"
              placeholder="You are a support assistant. Ask what the caller needs and answer clearly."
              rows={8}
            />
            <div className="grid gap-4 lg:grid-cols-2">
              <AssistantTextField
                control={form.control}
                name="backendInstructions"
                label="Tool choice instructions"
                placeholder="Choose the tool that matches the caller's request. Only report confirmed results."
                rows={4}
              />
              <AssistantTextField
                control={form.control}
                name="waitingBehavior"
                label="While waiting"
                placeholder="One moment while I check that."
                rows={4}
              />
            </div>
          </CardContent>
        </Card>
        <Collapsible open={connectionOpen} onOpenChange={setConnectionOpen}>
          <Card
            id="backend"
            className="scroll-mt-24 gap-3 rounded-lg py-4 shadow-none"
          >
            <CardHeader className="px-4">
              <CollapsibleTrigger asChild>
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-3 text-left focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <span>
                    <span className="block text-sm font-semibold">
                      Connection
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      Webhook and credentials
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    <Badge variant="outline" className="text-xs">
                      {hasSecret ? "Secret set" : "No secret"}
                    </Badge>
                    <CaretDown
                      className={`size-4 text-muted-foreground ${connectionOpen ? "rotate-180" : ""}`}
                      aria-hidden="true"
                    />
                  </span>
                </button>
              </CollapsibleTrigger>
            </CardHeader>
            <CollapsibleContent
              forceMount
              className="data-[state=closed]:hidden"
            >
              <CardContent className="px-4">
                <FieldGroup className="gap-4">
                  <AssistantTextField
                    control={form.control}
                    name="serverUrl"
                    label="Server URL"
                    placeholder="https://api.yourcompany.com/voice"
                    description="The HTTPS webhook endpoint on your backend that receives signed tool requests."
                  />
                  <Separator />
                  <FieldSet className="gap-4">
                    <FieldLegend className="mb-0 flex w-full flex-wrap items-center justify-between gap-2">
                      Webhook secret{" "}
                      <Badge variant="outline">
                        {hasSecret ? "Configured" : "Not configured"}
                      </Badge>
                    </FieldLegend>
                    <FieldDescription data-testid="secret-state">
                      {hasSecret
                        ? "A secret is set. It can't be shown — enter a new one to replace it."
                        : "No secret is set."}
                    </FieldDescription>
                    <AssistantTextField
                      control={form.control}
                      name="serverSecret"
                      label={hasSecret ? "Replace secret" : "New secret"}
                      type="password"
                      placeholder="Enter a new webhook signing secret"
                      description="Save after entering a new secret. It clears when you leave this page."
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
            </CollapsibleContent>
          </Card>
        </Collapsible>
        <Card
          id="tool-settings"
          className="min-w-0 scroll-mt-24 gap-3 rounded-lg py-4 shadow-none"
        >
          <CardHeader className="px-4">
            <CardTitle>
              <h2 className="text-sm">Tools</h2>
            </CardTitle>
            <CardDescription className="text-xs">
              Actions your backend can perform.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex min-w-0 flex-col gap-3 px-4">
            {toolsSummary.ok ? (
              toolsSummary.rows.length === 0 ? (
                <FieldDescription>No tools yet.</FieldDescription>
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
                        <TableCell className="max-w-48 font-medium break-words whitespace-normal">
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
                  className="group h-9 w-fit"
                >
                  {toolsOpen ? "Close JSON editor" : "Edit tools as JSON"}{" "}
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
                        Add a JSON array with each tool's name, description, and
                        parameters schema. Use [] for no tools.
                      </FieldDescription>
                      <Textarea
                        {...field}
                        id={field.name}
                        rows={14}
                        placeholder='[{"name":"check_status","description":"Check a request status","parameters":{"type":"object","properties":{}}}]'
                        className="min-h-64 leading-relaxed"
                        spellCheck={false}
                        onBlur={() => {
                          field.onBlur()
                          setToolsSummary(summarizeTools(field.value))
                          void form.trigger("tools")
                        }}
                        aria-invalid={fieldState.invalid}
                        aria-describedby={
                          fieldState.invalid
                            ? "tools-help tools-error"
                            : "tools-help"
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
  )
}
