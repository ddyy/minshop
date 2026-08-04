#!/usr/bin/env node
/**
 * Demo: an agent shops the store over the public catalog API.
 *
 *   node scripts/agent-demo.mjs <base-url> "<query>" [maxPrice]
 *   node scripts/agent-demo.mjs https://your-store.example.com "warm hat" 40
 *
 * Browses GET /api/products?q=…, picks the most relevant in-stock match within
 * the budget (search already ranks by relevance), then POST /api/checkout with
 * the product's prod_… public ID from the catalog (variant_id/extra_ids would
 * be var_/xtra_ public IDs from the detail route) — printing the FULL
 * Lightning invoice and polling its machine-readable status URL. Submit the
 * invoice to a wallet while this process runs; a paid digital item is saved in
 * the current directory.
 */
import { writeFile } from 'node:fs/promises';
const [base, query = 'warm hat', maxPrice] = process.argv.slice(2);
if (!base) {
  console.error('Usage: node scripts/agent-demo.mjs <base-url> "<query>" [maxPrice]');
  process.exit(1);
}
const budget = maxPrice ? Number(maxPrice) : Infinity;

// 1. Browse the catalog (semantic/keyword search).
const { products = [] } = await fetch(
  `${base}/api/products?q=${encodeURIComponent(query)}&limit=20`,
).then((r) => r.json());

// 2. Pick: most relevant in-stock product within budget (keep search ranking).
const candidates = products.filter((p) => p.in_stock && p.price.amount <= budget);

console.log(
  `Search "${query}"${Number.isFinite(budget) ? ` under ${budget}` : ''}: ${candidates.length} in-stock candidate(s)`,
);
for (const p of candidates.slice(0, 5)) {
  console.log(`  ${p.price.currency} ${p.price.amount}  ${p.name}  [${p.slug}]`);
}
const pick = candidates[0];
if (!pick) {
  console.log('\nNothing matched the budget.');
  process.exit(0);
}
console.log(`\nPicked: ${pick.name} — ${pick.price.currency} ${pick.price.amount}`);

// 3. Start a checkout for one, by the catalog's prod_… public ID (numeric row
//    IDs are rejected; slug also works as a documented convenience selector).
const res = await fetch(`${base}/api/checkout`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ items: [{ product_id: pick.id, quantity: 1 }], method: 'lightning' }),
});
const order = await res.json();
if (!res.ok) {
  console.error('Checkout failed:', order.error);
  process.exit(1);
}
if (!order.lightning?.invoice || !order.order_status_url) {
  console.error('This demo requires Lightning and the machine-readable order status API.');
  process.exit(1);
}
console.log('\nPay this BOLT11 invoice:');
console.log(order.lightning.invoice);
console.log(`Browser fallback: ${order.checkout_url}`);
console.log('Polling after payment submission; delayed settlement may pass through expired.');

for (;;) {
  const response = await fetch(order.order_status_url);
  if (response.status === 410) {
    console.error('The checkout status window closed before settlement was observed.');
    process.exit(2);
  }
  if (!response.ok) throw new Error(`Status request failed: ${response.status}`);
  const status = await response.json();
  console.log(`Status: ${status.status}`);
  if (status.status === 'paid' || status.status === 'refunded') {
    const downloads = (status.items ?? []).filter((item) => item.download_url);
    for (const [index, item] of downloads.entries()) {
      const fileResponse = await fetch(item.download_url);
      if (!fileResponse.ok) throw new Error(`Download failed: ${fileResponse.status}`);
      const disposition = fileResponse.headers.get('content-disposition') ?? '';
      const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
      const suggested = encoded ? decodeURIComponent(encoded) : `download-${index + 1}`;
      const filename = suggested.replace(/[^A-Za-z0-9._-]+/g, '-') || `download-${index + 1}`;
      await writeFile(filename, Buffer.from(await fileResponse.arrayBuffer()));
      console.log(`Saved ${filename}`);
    }
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
