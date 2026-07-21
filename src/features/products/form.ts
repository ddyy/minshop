import type { ProductFields } from './db';
import { toMinorUnits } from '../../money';

/**
 * Parse + validate the scalar product form fields. Prices arrive in major units
 * (e.g. dollars) and are stored as integer minor units, scaled by the product's
 * currency (×100 for USD, ×1 for JPY). The image upload is handled by the
 * endpoint, not here. Returns either the clean fields or a user-facing error.
 */
export function parseProductForm(
  form: FormData,
): { data: ProductFields } | { error: string } {
  const name = String(form.get('name') ?? '').trim();
  if (!name) return { error: 'Name is required.' };

  const price = Number(String(form.get('price') ?? '').trim());
  if (!Number.isFinite(price) || price < 0) {
    return { error: 'Price must be a non-negative number.' };
  }

  const stock = Number(String(form.get('stock') ?? '0').trim());
  if (!Number.isInteger(stock) || stock < 0) {
    return { error: 'Stock must be a non-negative whole number.' };
  }

  const currency = String(form.get('currency') ?? 'usd').trim().toLowerCase() || 'usd';
  // Scale by the chosen currency's minor units (so 1000 JPY stores as 1000, not 100000).
  const price_cents = toMinorUnits(price, currency);
  const description = String(form.get('description') ?? '').trim() || null;
  // Unchecked checkboxes submit nothing, so absence means inactive.
  const active = form.get('active') != null ? 1 : 0;

  return { data: { name, description, price_cents, currency, stock, active } };
}
