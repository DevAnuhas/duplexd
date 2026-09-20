import { notFound, redirect } from 'next/navigation';

import { updateAssistantAction } from '@/app/actions';
import { getAssistantForAccount } from '@/data/assistants';
import { getCurrentAccount } from '@/lib/account';
import { AssistantForm } from '../assistant-form';

export const dynamic = 'force-dynamic';

/**
 * The edit page.
 *
 * `getAssistantForAccount` scopes by account inside the query, so another
 * account's id is indistinguishable from one that does not exist — both are
 * `null`, and both become a 404. An archived assistant is `null` too, so it is
 * genuinely unreachable by URL rather than merely absent from the list.
 *
 * The assistant it passes down carries `hasServerSecret`, a boolean derived in
 * SQL. The ciphertext never leaves the database and there is nothing here that
 * could render it.
 */
export default async function EditAssistantPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const account = await getCurrentAccount();

  if (account === null) {
    redirect('/sign-in');
  }

  const { id } = await params;
  const assistant = await getAssistantForAccount(account.accountId, id);

  if (assistant === null) {
    notFound();
  }

  return (
    <main>
      <h1>{assistant.name}</h1>
      <AssistantForm
        values={assistant}
        action={updateAssistantAction.bind(null, id)}
        submitLabel="Save changes"
      />
    </main>
  );
}
