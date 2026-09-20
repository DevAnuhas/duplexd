import { Resend } from 'resend';

import { readEmailFrom, readResendApiKey } from '@/db/env';

/**
 * Outbound email. One provider, one message, one reason to exist: password
 * reset.
 *
 * **Constructed per send, not at module load.** The same rule as the database
 * client and the auth instance — building it at import would pull
 * `RESEND_API_KEY` into `next build`, and the static shell must build with no
 * secrets at all. It also means a deployment with no email configured never
 * constructs a client it cannot use.
 *
 * Nothing here logs the recipient, the URL or the token. The reset URL *is* a
 * bearer credential for one hour: anyone holding it can set that account's
 * password. A log line containing it is a password reset waiting in a log
 * aggregator.
 */

export type EmailResult = { ok: true } | { ok: false; reason: string };

/**
 * Sends the password reset link.
 *
 * Returns rather than throws, so the caller decides what the customer sees.
 * A delivery failure must never change the response of the endpoint that
 * triggered it — see the forgot-password page, which says the same thing
 * either way.
 */
export async function sendPasswordResetEmail({
  to,
  url,
}: {
  to: string;
  url: string;
}): Promise<EmailResult> {
  const apiKey = readResendApiKey();
  const from = readEmailFrom();

  if (apiKey === null || from === null) {
    return { ok: false, reason: 'email_not_configured' };
  }

  try {
    const { error } = await new Resend(apiKey).emails.send({
      from,
      to,
      subject: 'Reset your duplexd password',
      /*
        Plain text alongside HTML. A text part is what keeps this out of spam
        folders and readable in clients that refuse HTML — and for a message
        whose entire payload is one link, the text part is not a downgrade.
      */
      text: [
        'Someone asked to reset the password for your duplexd account.',
        '',
        'Open this link to choose a new one. It expires in one hour and can',
        'be used once:',
        '',
        url,
        '',
        'If this was not you, ignore this email. Your password stays as it is',
        'and nothing about your account has changed.',
      ].join('\n'),
      html: [
        '<p>Someone asked to reset the password for your duplexd account.</p>',
        `<p><a href="${url}">Choose a new password</a></p>`,
        '<p>The link expires in one hour and can be used once.</p>',
        '<p>If this was not you, ignore this email. Your password stays as it',
        'is and nothing about your account has changed.</p>',
      ].join('\n'),
    });

    return error === null || error === undefined
      ? { ok: true }
      : { ok: false, reason: error.name };
  } catch {
    // The provider was unreachable. The caller still tells the customer the
    // same thing it always does.
    return { ok: false, reason: 'delivery_failed' };
  }
}
