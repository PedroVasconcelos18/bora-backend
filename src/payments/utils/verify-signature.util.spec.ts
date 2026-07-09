import { createHmac } from 'crypto';
import { verifyMpSignature } from './verify-signature.util';

describe('verifyMpSignature', () => {
  const secret = 'test-fixture-secret-do-not-use-in-prod';
  const dataId = '123456789';
  const xRequestId = 'req-abc-123';
  const ts = '1704908010';

  function sign(manifest: string): string {
    return createHmac('sha256', secret).update(manifest).digest('hex');
  }

  it('validates true when the signature is computed with the correct secret over the manifest', () => {
    const manifest = `id:${dataId};request-id:${xRequestId};ts:${ts};`;
    const v1 = sign(manifest);
    const xSignature = `ts=${ts},v1=${v1}`;

    expect(verifyMpSignature({ xSignature, xRequestId, dataId, secret })).toBe(true);
  });

  it('validates false when the signature was computed over a tampered dataId', () => {
    const manifest = `id:${dataId};request-id:${xRequestId};ts:${ts};`;
    const v1 = sign(manifest);
    const xSignature = `ts=${ts},v1=${v1}`;

    expect(
      verifyMpSignature({ xSignature, xRequestId, dataId: 'tampered-data-id', secret }),
    ).toBe(false);
  });

  it('validates false when the signature was computed over a tampered ts', () => {
    const manifest = `id:${dataId};request-id:${xRequestId};ts:${ts};`;
    const v1 = sign(manifest);
    // Header claims a different ts than the one the signature was actually computed over
    const tamperedXSignature = `ts=9999999999,v1=${v1}`;

    expect(
      verifyMpSignature({ xSignature: tamperedXSignature, xRequestId, dataId, secret }),
    ).toBe(false);
  });

  it('returns false and never throws for a malformed x-signature header missing ts', () => {
    expect(() =>
      verifyMpSignature({ xSignature: 'v1=deadbeef', xRequestId, dataId, secret }),
    ).not.toThrow();
    expect(
      verifyMpSignature({ xSignature: 'v1=deadbeef', xRequestId, dataId, secret }),
    ).toBe(false);
  });

  it('returns false and never throws for a malformed x-signature header missing v1', () => {
    expect(() =>
      verifyMpSignature({ xSignature: `ts=${ts}`, xRequestId, dataId, secret }),
    ).not.toThrow();
    expect(
      verifyMpSignature({ xSignature: `ts=${ts}`, xRequestId, dataId, secret }),
    ).toBe(false);
  });

  it('returns false and never throws for a completely empty x-signature header', () => {
    expect(() =>
      verifyMpSignature({ xSignature: '', xRequestId, dataId, secret }),
    ).not.toThrow();
    expect(verifyMpSignature({ xSignature: '', xRequestId, dataId, secret })).toBe(false);
  });

  it('omits the request-id segment from the manifest and still validates when x-request-id is absent', () => {
    const manifest = `id:${dataId};ts:${ts};`;
    const v1 = sign(manifest);
    const xSignature = `ts=${ts},v1=${v1}`;

    expect(
      verifyMpSignature({ xSignature, xRequestId: undefined, dataId, secret }),
    ).toBe(true);
  });

  it('validates false when x-request-id is present but the manifest was computed without it (order/format sensitivity)', () => {
    // Signed as if request-id were absent, but the call provides xRequestId —
    // manifest built by the util MUST include request-id in this case, so it
    // must NOT match this signature computed without it.
    const manifest = `id:${dataId};ts:${ts};`;
    const v1 = sign(manifest);
    const xSignature = `ts=${ts},v1=${v1}`;

    expect(
      verifyMpSignature({ xSignature, xRequestId, dataId, secret }),
    ).toBe(false);
  });
});
