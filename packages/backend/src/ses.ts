/**
 * Amazon SES v2 without the AWS SDK: one endpoint (SendEmail), one SigV4
 * signature, ~zero dependencies. The SDK would add tens of megabytes and its
 * own credential machinery for what is a single signed POST.
 *
 * Credentials come from the standard AWS env names (AWS_ACCESS_KEY_ID,
 * AWS_SECRET_ACCESS_KEY, optional AWS_SESSION_TOKEN) so every AWS tool agrees
 * on them; the region from AWS_SES_REGION, falling back to AWS_REGION, then
 * us-east-1. The From identity must be verified in SES, and a new SES account
 * starts in sandbox mode (verified recipients only) until production access is
 * granted: see docs/DEPLOY.md.
 */
import { createHash, createHmac } from 'node:crypto';

const sha256hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const hmac = (key: Buffer | string, s: string): Buffer => createHmac('sha256', key).update(s, 'utf8').digest();

export const sesRegion = (env: NodeJS.ProcessEnv = process.env): string =>
  env.AWS_SES_REGION?.trim() || env.AWS_REGION?.trim() || 'us-east-1';

/** Real delivery is possible: both halves of the keypair are present. */
export const sesConfigured = (env: NodeJS.ProcessEnv = process.env): boolean =>
  !!(env.AWS_ACCESS_KEY_ID?.trim() && env.AWS_SECRET_ACCESS_KEY?.trim());

export interface SesSignInput {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
  host: string;
  path: string;
  payload: string;
  /** Injected so signing is a pure function the tests can pin. */
  now: Date;
}

/** AWS Signature Version 4 for one SES POST. Returns the headers to send.
 *  Exported (rather than inlined in the request) so a fixed input can be
 *  checked against an independently computed signature in tests. */
export function signSesRequest(input: SesSignInput): Record<string, string> {
  const amzDate = input.now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); // 20260805T000000Z
  const dateStamp = amzDate.slice(0, 8);

  // Canonical headers must be sorted by name; the optional security token
  // sorts after x-amz-date, so appending keeps the order correct.
  let canonicalHeaders = `content-type:application/json\nhost:${input.host}\nx-amz-date:${amzDate}\n`;
  let signedHeaders = 'content-type;host;x-amz-date';
  if (input.sessionToken) {
    canonicalHeaders += `x-amz-security-token:${input.sessionToken}\n`;
    signedHeaders += ';x-amz-security-token';
  }

  const canonicalRequest = ['POST', input.path, '', canonicalHeaders, signedHeaders, sha256hex(input.payload)].join('\n');
  const scope = `${dateStamp}/${input.region}/ses/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');

  let key = hmac(`AWS4${input.secretAccessKey}`, dateStamp);
  key = hmac(key, input.region);
  key = hmac(key, 'ses');
  key = hmac(key, 'aws4_request');
  const signature = createHmac('sha256', key).update(stringToSign, 'utf8').digest('hex');

  return {
    'content-type': 'application/json',
    'x-amz-date': amzDate,
    ...(input.sessionToken ? { 'x-amz-security-token': input.sessionToken } : {}),
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

export interface SesSendResult {
  ok: boolean;
  /** Why it failed, safe to show an admin. Never contains a credential. */
  error?: string;
}

/** One SES v2 SendEmail call. Throws nothing: callers get {ok, error}. */
export async function sendViaSes(
  msg: { from: string; to: string; subject: string; html: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<SesSendResult> {
  const region = sesRegion(env);
  const host = `email.${region}.amazonaws.com`;
  const path = '/v2/email/outbound-emails';
  const payload = JSON.stringify({
    FromEmailAddress: msg.from,
    Destination: { ToAddresses: [msg.to] },
    Content: {
      Simple: {
        Subject: { Data: msg.subject, Charset: 'UTF-8' },
        Body: { Html: { Data: msg.html, Charset: 'UTF-8' } },
      },
    },
  });
  const headers = signSesRequest({
    accessKeyId: env.AWS_ACCESS_KEY_ID!.trim(),
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY!.trim(),
    sessionToken: env.AWS_SESSION_TOKEN?.trim() || undefined,
    region,
    host,
    path,
    payload,
    now: new Date(),
  });
  try {
    const res = await fetch(`https://${host}${path}`, { method: 'POST', headers, body: payload });
    const body = await res.text().catch(() => '');
    if (!res.ok) {
      // SES's body names the exact problem (unverified identity, sandbox
      // recipient, bad region). It never echoes credentials, so pass it through.
      return { ok: false, error: `SES responded ${res.status}: ${body || '(empty body)'}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error)?.message ?? String(err) };
  }
}
