import { notFound } from 'next/navigation';

import { updateAssistantAction } from '@/app/actions';
import { getAssistantForAccount } from '@/data/assistants';
import { requireShell } from '../../shell-data';
import { AssistantForm } from '../assistant-form';

type PageProps = {
  params: Promise<{ id: string }>;
};

export const dynamic = 'force-dynamic';

export default async function EditAssistantPage({ params }: PageProps) {
  const { account } = await requireShell();

  const { id } = await params;
  // Account-scoped projection excludes ciphertext; absent, archived, and
  // another account's assistant all remain indistinguishable 404s.
  const assistant = await getAssistantForAccount(account.id, id);
  if (assistant === null) notFound();

  return (
    <AssistantForm
      values={assistant}
      action={updateAssistantAction.bind(null, id)}
      submitLabel="Save changes"
    />
  );
}
