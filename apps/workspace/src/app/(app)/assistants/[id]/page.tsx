import { Suspense } from 'react';
import { AssistantEditorSkeleton } from '../assistant-editor-skeleton';
import { notFound } from 'next/navigation';

import { updateAssistantAction } from '@/app/actions';
import { getAssistantForAccount } from '@/data/assistants';
import { requireShell } from '../../shell-data';
import { AssistantForm } from '../assistant-form';

type PageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string }>;
};

export default function EditAssistantPage(props: PageProps) {
  return (
    <Suspense fallback={<AssistantEditorSkeleton />}>
      <EditAssistant {...props} />
    </Suspense>
  );
}

async function EditAssistant({ params, searchParams }: PageProps) {
  const { account } = await requireShell();

  const { id } = await params;
  // Account-scoped projection excludes ciphertext; absent, archived, and
  // another account's assistant all remain indistinguishable 404s.
  const assistant = await getAssistantForAccount(account.id, id);
  if (assistant === null) notFound();
  const { saved } = await searchParams;

  return (
    <AssistantForm
      values={assistant}
      action={updateAssistantAction.bind(null, id)}
      submitLabel="Save changes"
      initiallySaved={saved === '1'}
    />
  );
}
