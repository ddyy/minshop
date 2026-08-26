import { describe, expect, it } from 'vitest';
import {
  hashMemberCode,
  memberSessionCodeId,
  signMemberSession,
  verifyMemberCode,
} from './member';

const SECRET = 'test-auth-secret-for-member-sessions';

describe('member access codes', () => {
  it('hashes and verifies a code', async () => {
    const encoded = await hashMemberCode('club-access-code-1234');
    expect(encoded.startsWith('pbkdf2-sha256$')).toBe(true);
    await expect(verifyMemberCode('club-access-code-1234', encoded)).resolves.toBe(true);
    await expect(verifyMemberCode('wrong-code-here!!', encoded)).resolves.toBe(false);
  });

  it('round-trips a signed member session', async () => {
    const token = await signMemberSession(7, SECRET, 1_700_000_000);
    await expect(memberSessionCodeId(token, SECRET, 1_700_000_000)).resolves.toBe(7);
    await expect(memberSessionCodeId(token, SECRET, 1_700_000_000 + 31 * 24 * 60 * 60)).resolves.toBeNull();
    await expect(memberSessionCodeId(token, 'other-secret', 1_700_000_000)).resolves.toBeNull();
  });
});
