'use server';

import { revalidatePath } from 'next/cache';

import {
  archiveAssistantForAccount,
  createAssistant,
  updateAssistantForAccount,
  type AssistantInput,
} from '@/data/assistants';
import { deleteApiKey, mintApiKey, revokeApiKey } from '@/data/api-keys';
import { requireCurrentAccount } from '@/lib/account';
import { apiKeyNameSchema } from '@/lib/api-key-schemas';
import { validateServerUrl, validateTools, type ValidationIssue } from '@/lib/validate';

/**
 * **Every write surface for assistants and API keys is in this file.**
 *
 * That is deliberate and it is the point: the contract requires the set of
 * places that write these tables to be finite and enumerable, so "every write
 * validates and every write is scoped" is something a reviewer can check
 * rather than take on trust. There are no route handlers writing these tables.
 * If one is added, it calls the same two functions below.
 *
 * Every action here does exactly two things before touching data:
 *
 *  1. `requireCurrentAccount()` — the one resolver, reading the account from
 *     the server-side session and never from anything the caller can set.
 *  2. `validateTools` / `validateServerUrl` — the one validator, so the form
 *     and any future API path cannot drift into disagreeing about what is
 *     acceptable.
 *
 * Nothing here logs its input. The secret arrives as plaintext in `formData`
 * before encryption, so an error handler that logged the payload would leak it
 * regardless of how carefully the database layer behaves.
 */

export type ActionResult =
  | { ok: true; assistantId?: string }
  | { ok: false; issues: ValidationIssue[] };

/** The one place a submitted assistant is turned into validated input. */
function readAssistantInput(formData: FormData): {
  input: AssistantInput & { clearServerSecret?: boolean };
  issues: ValidationIssue[];
} {
  const text = (key: string): string | null => {
    const value = formData.get(key);
    return typeof value === 'string' && value.trim() !== '' ? value : null;
  };

  const name = text('name') ?? '';
  const serverUrl = text('serverUrl');
  const rawTools = text('tools');

  const issues: ValidationIssue[] = [];

  if (name === '') {
    issues.push({ field: 'name', message: 'An assistant needs a name.' });
  }

  let tools: unknown = [];

  if (rawTools !== null) {
    try {
      tools = JSON.parse(rawTools);
    } catch (error) {
      issues.push({
        field: 'tools',
        message: `Tools must be valid JSON — ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  }

  issues.push(...validateTools(tools));

  const urlIssue = validateServerUrl(serverUrl);
  if (urlIssue !== null) {
    issues.push(urlIssue);
  }

  return {
    input: {
      name,
      voice: text('voice'),
      accentStyle: text('accentStyle'),
      instructions: text('instructions'),
      backendInstructions: text('backendInstructions'),
      backendModel: text('backendModel'),
      waitingBehavior: text('waitingBehavior'),
      serverUrl,
      serverSecret: text('serverSecret'),
      clearServerSecret: formData.get('clearServerSecret') === 'on',
      tools,
    },
    issues,
  };
}

export async function createAssistantAction(
  formData: FormData,
): Promise<ActionResult> {
  const { accountId } = await requireCurrentAccount();
  const { input, issues } = readAssistantInput(formData);

  // Rejected at save, never at call time: the alternative is the customer
  // discovering a malformed tool with a caller on the line.
  if (issues.length > 0) {
    return { ok: false, issues };
  }

  const created = await createAssistant(accountId, input);
  revalidatePath('/assistants');

  return { ok: true, assistantId: created.id };
}

export async function updateAssistantAction(
  assistantId: string,
  formData: FormData,
): Promise<ActionResult> {
  const { accountId } = await requireCurrentAccount();
  const { input, issues } = readAssistantInput(formData);

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  const updated = await updateAssistantForAccount(accountId, assistantId, input);

  if (updated === null) {
    return {
      ok: false,
      issues: [{ field: 'name', message: 'That assistant no longer exists.' }],
    };
  }

  revalidatePath('/assistants');

  return { ok: true };
}

export async function archiveAssistantAction(
  assistantId: string,
): Promise<ActionResult> {
  const { accountId } = await requireCurrentAccount();

  await archiveAssistantForAccount(accountId, assistantId);
  revalidatePath('/assistants');

  return { ok: true };
}

/**
 * Mints a key and returns it **once**.
 *
 * The raw key travels exactly this far: from here to the page that shows it.
 * It is not revalidated into a cache, not stored, and not recoverable — the
 * caller displays it and it is gone.
 */
export async function mintApiKeyAction(
  formData: FormData,
): Promise<{ ok: true; raw: string; prefix: string } | { ok: false; issues: ValidationIssue[] }> {
  const { accountId, userId } = await requireCurrentAccount();
  const parsed = apiKeyNameSchema.safeParse({ name: formData.get('name') });

  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        field: 'name',
        message: issue.message,
      })),
    };
  }

  const minted = await mintApiKey(accountId, parsed.data.name, userId);
  revalidatePath('/keys');

  return { ok: true, raw: minted.raw, prefix: minted.prefix };
}

export async function revokeApiKeyAction(keyId: string): Promise<ActionResult> {
  const { accountId } = await requireCurrentAccount();

  await revokeApiKey(accountId, keyId);
  revalidatePath('/keys');

  return { ok: true };
}

export async function deleteApiKeyAction(keyId: string): Promise<ActionResult> {
  const { accountId } = await requireCurrentAccount();
  const result = await deleteApiKey(accountId, keyId);

  if (result === 'has_calls') {
    return {
      ok: false,
      issues: [
        {
          field: 'keyId',
          message: 'This key has calls attributed to it; revoke it instead',
        },
      ],
    };
  }

  if (result === 'not_found') {
    return {
      ok: false,
      issues: [{ field: 'keyId', message: 'That API key no longer exists.' }],
    };
  }

  revalidatePath('/keys');

  return { ok: true };
}
