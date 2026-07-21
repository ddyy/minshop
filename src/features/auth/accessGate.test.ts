import { describe, expect, it } from 'vitest';
import { accessGateDecision } from './accessGate';

describe('accessGateDecision', () => {
  it('allows first-run bootstrap only when Access is entirely unconfigured', () => {
    expect(accessGateDecision(null, undefined, undefined)).toEqual({ action: 'bootstrap' });
  });

  it('fails closed when configured Access receives no assertion', () => {
    expect(accessGateDecision(null, 'https://team.cloudflareaccess.com', 'aud')).toEqual({
      action: 'deny',
      message: 'Cloudflare Access authentication required.',
    });
  });

  it('fails closed when only one Access variable is configured', () => {
    expect(accessGateDecision(null, 'https://team.cloudflareaccess.com', undefined).action).toBe('deny');
    expect(accessGateDecision(null, undefined, 'aud').action).toBe('deny');
  });

  it('rejects an unverifiable assertion when Access is unconfigured', () => {
    expect(accessGateDecision('forged', undefined, undefined).action).toBe('deny');
  });

  it('returns complete inputs only for a verifiable Access request', () => {
    expect(accessGateDecision('signed', 'https://team.cloudflareaccess.com', 'aud')).toEqual({
      action: 'verify',
      token: 'signed',
      teamDomain: 'https://team.cloudflareaccess.com',
      aud: 'aud',
    });
  });
});
