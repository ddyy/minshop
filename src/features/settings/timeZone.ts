// A small always-available fallback if the runtime lacks Intl.supportedValuesOf.
const COMMON_ZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Africa/Johannesburg',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Australia/Sydney',
];

/** Every IANA time zone the runtime knows (~400+), for the store time-zone picker. */
export function allTimeZones(): string[] {
  try {
    const intl = Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] };
    return intl.supportedValuesOf?.('timeZone') ?? COMMON_ZONES;
  } catch {
    return COMMON_ZONES;
  }
}

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
