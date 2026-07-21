/** Return a canonical supported IANA time zone, or null for invalid input. */
export function normalizeTimeZone(value: string | null | undefined): string | null {
  const zone = value?.trim();
  if (!zone) return null;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}
