/** Supported carriers for fulfillment tracking. */
export const CARRIERS = [
  { code: 'usps', name: 'USPS' },
  { code: 'ups', name: 'UPS' },
  { code: 'fedex', name: 'FedEx' },
  { code: 'dhl', name: 'DHL' },
  { code: 'royal_mail', name: 'Royal Mail' },
  { code: 'dpd', name: 'DPD' },
  { code: 'evri', name: 'Evri' },
  { code: 'tnt', name: 'TNT' },
  { code: 'other', name: 'Other' },
] as const;

export function carrierName(code: string | null): string {
  return CARRIERS.find((c) => c.code === code)?.name ?? code ?? '—';
}

/** Public tracking URL for a carrier + number, or null when not linkable. */
export function trackingUrl(carrier: string | null, number: string | null): string | null {
  if (!carrier || !number) return null;
  const n = encodeURIComponent(number);
  switch (carrier) {
    case 'usps':
      return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}`;
    case 'ups':
      return `https://www.ups.com/track?tracknum=${n}`;
    case 'fedex':
      return `https://www.fedex.com/fedextrack/?trknbr=${n}`;
    case 'dhl':
      return `https://www.dhl.com/en/express/tracking.html?AWB=${n}`;
    case 'royal_mail':
      return `https://www.royalmail.com/track-your-item#/tracking-results/${n}`;
    case 'dpd':
      return `https://www.dpd.co.uk/apps/tracking/?parcel=${n}`;
    case 'evri':
      return `https://www.evri.com/track/parcel/${n}`;
    case 'tnt':
      return `https://www.tnt.com/express/en_gb/site/tracking.html?searchType=con&cons=${n}`;
    default:
      return null; // 'other' / unknown — show the number without a link
  }
}
