/**
 * Shared chrome for transactional email.
 *
 * Email clients are not browsers: <style> blocks get stripped, flexbox/grid and
 * external CSS don't apply, and Outlook renders through Word. So everything here
 * is INLINE styles on table-based layout, which is the subset that renders
 * consistently. Rounded corners and max-width degrade gracefully (Outlook shows
 * square corners at full width) rather than breaking.
 *
 * Colors mirror src/styles/theme.css. They're literals because a stylesheet
 * variable can't reach an inbox; rebrand by editing PALETTE here and theme.css.
 */

export const PALETTE = {
  brand: '#111827', // --color-brand: buttons, headings
  paper: '#faf8f4', // --color-paper: page background
  line: '#e7e2d9', // --color-line: borders + rules
  card: '#ffffff',
  text: '#1f2937',
  muted: '#6b7280',
} as const;

/** Serif for the store name (matches the storefront wordmark), system sans for body. */
const SERIF = "Georgia, 'Times New Roman', serif";
const SANS =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });

/** A call-to-action button. Table-wrapped so Outlook honors the padding + fill. */
export function emailButton(href: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;">
    <tr><td bgcolor="${PALETTE.brand}" style="border-radius:6px;">
      <a href="${href}" style="display:inline-block;padding:12px 26px;font-family:${SANS};font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;">${escapeHtml(label)}</a>
    </td></tr>
  </table>`;
}

/** A muted label above a block of content (e.g. "Ship to"). */
export function emailLabel(text: string): string {
  return `<p style="margin:24px 0 6px;font-family:${SANS};font-size:11px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:${PALETTE.muted};">${escapeHtml(text)}</p>`;
}

export interface ShellOptions {
  storeName: string;
  /** Big line at the top of the card. */
  heading: string;
  /** Optional smaller line under the heading. */
  subheading?: string;
  /** Pre-built HTML for the card body. */
  body: string;
  /** Small print under the card. */
  footer?: string;
}

/**
 * Wrap content in the branded shell: store wordmark, white card on paper, footer.
 * `body` is inserted as-is, so callers escape their own interpolations.
 */
export function emailShell({
  storeName,
  heading,
  subheading,
  body,
  footer,
}: ShellOptions): string {
  return `<div style="margin:0;padding:24px 12px;background:${PALETTE.paper};font-family:${SANS};color:${PALETTE.text};-webkit-font-smoothing:antialiased;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;margin:0 auto;">
    <tr>
      <td style="padding:0 4px 16px;font-family:${SERIF};font-size:22px;letter-spacing:-0.01em;color:${PALETTE.brand};">
        ${escapeHtml(storeName)}
      </td>
    </tr>
    <tr>
      <td style="background:${PALETTE.card};border:1px solid ${PALETTE.line};border-radius:8px;padding:32px 28px;">
        <h1 style="margin:0;font-family:${SERIF};font-size:24px;font-weight:400;line-height:1.25;color:${PALETTE.brand};">${escapeHtml(heading)}</h1>
        ${subheading ? `<p style="margin:8px 0 0;font-size:14px;color:${PALETTE.muted};">${subheading}</p>` : ''}
        ${body}
      </td>
    </tr>
    ${
      footer
        ? `<tr><td style="padding:16px 4px 0;font-size:12px;line-height:1.5;color:${PALETTE.muted};">${footer}</td></tr>`
        : ''
    }
  </table>
</div>`;
}

export interface LineItem {
  /** Pre-built <td> for the thumbnail, or '' for no image column. */
  thumb: string;
  name: string;
  quantity: number;
  amount: string;
}

export interface TotalRow {
  label: string;
  amount: string;
  strong?: boolean;
}

/** Line items with a right-aligned totals block beneath them. */
export function emailItemsTable(items: LineItem[], totals: TotalRow[]): string {
  const rows = items
    .map(
      (it) => `<tr>
      ${it.thumb}
      <td style="padding:10px 8px;font-size:14px;line-height:1.4;border-bottom:1px solid ${PALETTE.line};">
        ${escapeHtml(it.name)}
        <span style="color:${PALETTE.muted};">&times; ${it.quantity}</span>
      </td>
      <td style="padding:10px 0;font-size:14px;text-align:right;white-space:nowrap;border-bottom:1px solid ${PALETTE.line};">${it.amount}</td>
    </tr>`,
    )
    .join('');

  const totalRows = totals
    .map(({ label, amount, strong }) => {
      const weight = strong ? 'font-weight:600;' : '';
      const size = strong ? 'font-size:16px;' : 'font-size:14px;';
      const rule = strong ? `border-top:1px solid ${PALETTE.line};` : '';
      const color = strong ? PALETTE.brand : PALETTE.muted;
      return `<tr>
        <td style="padding:8px 8px 0;${size}${weight}${rule}color:${color};text-align:right;">${escapeHtml(label)}</td>
        <td style="padding:8px 0 0;${size}${weight}${rule}color:${strong ? PALETTE.brand : PALETTE.text};text-align:right;white-space:nowrap;width:96px;">${amount}</td>
      </tr>`;
    })
    .join('');

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:24px;border-collapse:collapse;">
    ${rows}
  </table>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:8px;border-collapse:collapse;">
    ${totalRows}
  </table>`;
}
