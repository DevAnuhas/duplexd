import { Suspense } from 'react';
import { AssistantEditorSkeleton } from '../assistant-editor-skeleton';

import { createAssistantAction } from '@/app/actions';
import { requireShell } from '../../shell-data';
import { AssistantForm } from '../assistant-form';

export default function NewAssistantPage() {
  return (
    <Suspense fallback={<AssistantEditorSkeleton />}>
      <NewAssistant />
    </Suspense>
  );
}

async function NewAssistant() {
  await requireShell();

  return (
    <AssistantForm
      values={{ hasServerSecret: false }}
      action={createAssistantAction}
      submitLabel="Create assistant"
    />
  );
}
