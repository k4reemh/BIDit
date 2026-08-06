import { describe, it, expect } from 'vitest';
import { signSesRequest, sesConfigured, sesRegion } from '../src/ses.js';

// The expected signatures were computed with an INDEPENDENT SigV4
// implementation (Python hashlib/hmac following AWS's published algorithm),
// not with this module: the test pins correctness, not self-consistency.
const FIXED = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
  host: 'email.us-east-1.amazonaws.com',
  path: '/v2/email/outbound-emails',
  payload: '{"test":"payload"}',
  now: new Date('2026-08-05T00:00:00.000Z'),
};

describe('signSesRequest', () => {
  it('produces the reference SigV4 signature for a fixed request', () => {
    const headers = signSesRequest(FIXED);
    expect(headers['x-amz-date']).toBe('20260805T000000Z');
    expect(headers['content-type']).toBe('application/json');
    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260805/us-east-1/ses/aws4_request, ' +
        'SignedHeaders=content-type;host;x-amz-date, ' +
        'Signature=7d2f908d76718372ef186d558fa3a5a1d227ccff055132e81db470d4c3e6053a',
    );
    expect(headers['x-amz-security-token']).toBeUndefined();
  });

  it('folds a session token into the signed headers and the signature', () => {
    const headers = signSesRequest({ ...FIXED, sessionToken: 'THESESSIONTOKEN' });
    expect(headers['x-amz-security-token']).toBe('THESESSIONTOKEN');
    expect(headers.authorization).toContain('SignedHeaders=content-type;host;x-amz-date;x-amz-security-token');
    expect(headers.authorization).toContain(
      'Signature=5407170ec28503a5011315b71464785cb21755dbcb87aa9a0d976fb9067617d3',
    );
  });

  it('changes the signature when the payload changes (payload is signed)', () => {
    const a = signSesRequest(FIXED);
    const b = signSesRequest({ ...FIXED, payload: '{"test":"tampered"}' });
    expect(a.authorization).not.toBe(b.authorization);
  });
});

describe('sesConfigured / sesRegion', () => {
  it('needs both halves of the keypair', () => {
    expect(sesConfigured({})).toBe(false);
    expect(sesConfigured({ AWS_ACCESS_KEY_ID: 'a' })).toBe(false);
    expect(sesConfigured({ AWS_SECRET_ACCESS_KEY: 'b' })).toBe(false);
    expect(sesConfigured({ AWS_ACCESS_KEY_ID: '  ' , AWS_SECRET_ACCESS_KEY: 'b' })).toBe(false);
    expect(sesConfigured({ AWS_ACCESS_KEY_ID: 'a', AWS_SECRET_ACCESS_KEY: 'b' })).toBe(true);
  });

  it('resolves the region: SES-specific, then generic, then us-east-1', () => {
    expect(sesRegion({})).toBe('us-east-1');
    expect(sesRegion({ AWS_REGION: 'eu-west-1' })).toBe('eu-west-1');
    expect(sesRegion({ AWS_REGION: 'eu-west-1', AWS_SES_REGION: 'ca-central-1' })).toBe('ca-central-1');
  });
});
