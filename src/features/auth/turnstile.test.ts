import { describe, it, expect, afterEach, vi } from 'vitest';
import { verifyTurnstileToken } from './turnstile';

const SECRET = 'test-secret';

afterEach(() => vi.unstubAllGlobals());

describe('verifyTurnstileToken', () => {
  it('returns true on success:true and posts secret + response', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ success: true }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    expect(await verifyTurnstileToken('tok', SECRET, '1.2.3.4')).toBe(true);
    const [, init] = fetchMock.mock.calls[0];
    const body = (init as RequestInit).body?.toString() ?? '';
    expect(body).toContain('secret=test-secret');
    expect(body).toContain('response=tok');
    expect(body).toContain('remoteip=1.2.3.4');
  });

  it('returns false on success:false', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ success: false }), { status: 200 })),
    );
    expect(await verifyTurnstileToken('tok', SECRET)).toBe(false);
  });

  it('short-circuits to false on an empty token (no fetch)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await verifyTurnstileToken('', SECRET)).toBe(false);
    expect(await verifyTurnstileToken(null, SECRET)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed on a non-OK response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('err', { status: 500 })));
    expect(await verifyTurnstileToken('tok', SECRET)).toBe(false);
  });

  it('fails closed when fetch throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network');
      }),
    );
    expect(await verifyTurnstileToken('tok', SECRET)).toBe(false);
  });
});
