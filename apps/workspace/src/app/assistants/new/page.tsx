import { redirect } from 'next/navigation';

import { createAssistantAction } from '@/app/actions';
import { getCurrentAccount } from '@/lib/account';
import { AssistantForm } from '../assistant-form';

export const dynamic = 'force-dynamic';

export default async function NewAssistantPage() {
  if ((await getCurrentAccount()) === null) {
    redirect('/sign-in');
  }

  return (
    <main>
      <h1>New assistant</h1>
      <AssistantForm
        values={{ hasServerSecret: false }}
        action={createAssistantAction}
        submitLabel="Create assistant"
      />
    </main>
  );
}
