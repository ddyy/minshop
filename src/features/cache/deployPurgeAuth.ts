const AUTH_SCHEME = 'MinshopDeploy';
const MESSAGE_SCOPE = 'cache-deploy-purge:v1';
export const DEPLOY_PURGE_WINDOW_SECONDS = 5 * 60;

const encoder = new TextEncoder();

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function constantTimeEqual(left: string, right: string): Promise<boolean> {
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(left)),
    crypto.subtle.digest('SHA-256', encoder.encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftHash);
  const rightBytes = new Uint8Array(rightHash);
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index++) {
    difference |= leftBytes[index] ^ rightBytes[index];
  }
  return difference === 0;
}

function message(timestampSeconds: string): string {
  return `${MESSAGE_SCOPE}:${timestampSeconds}`;
}

/** Build the short-lived Authorization value used immediately after a deploy. */
export async function signDeployPurgeAuthorization(
  secret: string,
  timestampSeconds: number,
): Promise<string> {
  const timestamp = String(Math.floor(timestampSeconds));
  return `${AUTH_SCHEME} ${timestamp}.${await hmacHex(secret, message(timestamp))}`;
}

/** Verify scheme, timestamp window, and HMAC without comparing secrets directly. */
export async function verifyDeployPurgeAuthorization(
  authorization: string | null,
  secret: string,
  nowSeconds: number,
): Promise<boolean> {
  const match = authorization?.match(/^MinshopDeploy ([0-9]{10})\.([0-9a-f]{64})$/);
  if (!match) return false;
  const [, timestamp, providedSignature] = match;
  const signedAt = Number(timestamp);
  if (
    !Number.isSafeInteger(signedAt) ||
    Math.abs(Math.floor(nowSeconds) - signedAt) > DEPLOY_PURGE_WINDOW_SECONDS
  ) {
    return false;
  }
  const expectedSignature = await hmacHex(secret, message(timestamp));
  return constantTimeEqual(providedSignature, expectedSignature);
}
