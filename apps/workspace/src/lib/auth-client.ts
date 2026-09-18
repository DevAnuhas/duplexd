import { createAuthClient } from 'better-auth/react';

/** Browser-side client. Holds no secret; it only talks to `/api/auth`. */
export const authClient = createAuthClient();
