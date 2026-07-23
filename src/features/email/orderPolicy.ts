/** Demo orders notify the store owner, but never contact the demo customer. */
export function shouldSendCustomerOrderEmail(
  paymentMethod: string | null | undefined,
): boolean {
  return paymentMethod !== 'demo';
}
