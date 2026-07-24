/** Demo orders notify the store owner, but never contact the demo customer. */
export function shouldSendCustomerOrderEmail(
  paymentMethod: string | null | undefined,
): boolean {
  return paymentMethod !== 'demo';
}

/** Resolve and validate the address required to place a demo order. */
export function resolveRequiredOrderEmail(
  submittedEmail: string,
  existingEmail: string | null | undefined,
): string | null {
  const email = submittedEmail.trim() || existingEmail?.trim() || '';
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}
