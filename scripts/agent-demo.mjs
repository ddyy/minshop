#!/usr/bin/env node
/**
 * Demo: an agent shops the store over the public catalog API.
 *
 *   node scripts/agent-demo.mjs <base-url> "<query>" [maxPrice]
 *   node scripts/agent-demo.mjs https://your-store.example.com "warm hat" 40
 *
 * Browses GET /api/products?q=…, picks the most relevant in-stock match within
 * the budget (search already ranks by relevance), then POST /api/checkout to
 * start a purchase — printing the FULL
 * checkout URL (the #fragment carries the session token; never truncate it).
 * Prod runs Stripe TEST keys, so paying with 4242 4242 4242 4242 charges nothing.
 */
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

// 3. Start a checkout for one.
const res = await fetch(`${base}/api/checkout`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ items: [{ slug: pick.slug, quantity: 1 }] }),
});
const order = await res.json();
if (!res.ok) {
  console.error('Checkout failed:', order.error);
  process.exit(1);
}
console.log('\nPay here (Stripe test card 4242 4242 4242 4242, any future expiry/CVC/postal):');
console.log(order.checkout_url); // full URL — do not truncate
