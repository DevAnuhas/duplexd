import { authenticateCustomer, json, problem } from '@/control/http';
import { getCallForAccount } from '@/data/calls';


export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await authenticateCustomer(request);
  if (!auth.ok) {
    return auth.response;
  }

  const { id } = await params;
  const result = await getCallForAccount(auth.accountId, id);

  return result === null
    ? problem(404, 'call_not_found', 'The call was not found.')
    : json(result);
}
