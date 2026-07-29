/**
 * Storefront baseline capture and comparison.
 *
 * Answers one question only: "did moving the default markup change anything?"
 * It is deliberately strict about structure, so it is NOT part of the normal
 * verify chain — a customized storefront is expected to fail it. See
 * npm run test:storefront-contract for the checks that survive a redesign.
 *
 * Usage: node test/helpers/baselines.mjs <port> [--update]
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeHeaders, normalizeHtml } from './normalize-html.mjs';

const BASELINE_DIR = 'test/baselines/storefront';

/**
 * Every surface that renders a product card, plus the Layout.astro consumers an
 * extraction could disturb. Names become file names, so they stay stable across
 * releases.
 *
 * The shell is NOT browse-only: moving the header and footer into store-owned
 * files puts them on cart, checkout, payment, and authentication pages too, so
 * those routes are baselined alongside the catalog.
 *
 * Coverage limits, stated rather than implied:
 *
 *   /order/<token>, /pay/<publicId>   absent — both need a real order or invoice.
 *   /account, /account/login          baseline their 303. Accounts require a
 *                                     configured email provider in the encrypted
 *                                     vault, which the fixture cannot mint.
 *   /admin/login                      baselines its 303 to /admin/setup, which
 *                                     is where it goes until a credential hash
 *                                     exists.
 *
 * Those four still render the shared shell in production, so they stay on the
 * manual visual-review list. The redirect itself is worth pinning: a changed
 * status or Location is a routing regression regardless of markup.
 *
 *   /checkout                       baselines its 303 to /cart. With no real
 *                                     payment rail configured the only usable
 *                                     rail is demo, and asking for it makes the
 *                                     route MINT an invoice and redirect to
 *                                     /pay/otk_… — an order created as a side
 *                                     effect of taking a baseline, with a random
 *                                     token that could never compare equal.
 *                                     Its shell needs a configured rail.
 */
export const ROUTES = [
  // Browse surfaces (product cards).
  { name: 'home', path: '/' },
  { name: 'catalog', path: '/products' },
  { name: 'catalog-sorted-page2', path: '/products?sort=price&dir=asc&page=2' },
  { name: 'category', path: '/categories/apparel' },
  { name: 'search', path: '/search?q=sample' },
  { name: 'search-empty', path: '/search?q=zzzznomatch' },
  // sample-tee carries variants, extras, and a multi-image gallery; the
  // pagination items are the plain and sold-out shapes.
  { name: 'product-detail', path: '/products/sample-tee' },
  { name: 'product-detail-plain', path: '/products/pagination-item-2' },
  { name: 'product-detail-sold-out', path: '/products/pagination-item-1' },
  { name: 'content-page', path: '/pages/about' },
  { name: 'not-found', path: '/no-such-page' },
  // Transactional and authentication surfaces — same shell, different stakes.
  { name: 'cart', path: '/cart', withCart: true },
  { name: 'checkout', path: '/checkout', withCart: true },
  { name: 'express', path: '/express', withCart: true },
  { name: 'payment-setup', path: '/payment-setup' },
  { name: 'account', path: '/account' },
  { name: 'account-login', path: '/account/login' },
  { name: 'admin-login', path: '/admin/login' },
];

/**
 * Checkout and express redirect away from an empty cart, so without a cart they
 * baseline a 303 and never exercise the shell they render — which is the whole
 * point of covering them. Establish one real cart line through the public API
 * (the cookie is application-owned; forging it would test a shape rather than
 * the contract) and reuse its cookie for those routes.
 */
async function cartCookie(origin) {
  const catalog = await fetch(new URL('/api/products?limit=50', origin));
  const { products } = await catalog.json();
  // A product WITH variants requires one to be chosen, and `add` redirects back
  // to the product page instead of setting a cookie. Pick a plain, in-stock line.
  const productId = products?.find((p) => p.variant_label === null && p.in_stock)?.id;
  if (!productId) {
    throw new Error('baseline fixture has no variant-free, in-stock product to add to the cart');
  }

  const response = await fetch(new URL('/api/cart', origin), {
    method: 'POST',
    redirect: 'manual',
    // The middleware rejects cross-site form posts by comparing Origin with the
    // request origin (astro.config disables Astro's own checkOrigin in favour of
    // it). Without this header the add is a 403, not a redirect.
    headers: { origin },
    body: new URLSearchParams({ _action: 'add', product_id: productId, qty: '1' }),
  });
  const cookies = response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0])
    .join('; ');
  if (!cookies.includes('cart')) {
    throw new Error(
      `add-to-cart did not establish a cart cookie (status ${response.status})`,
    );
  }
  return cookies;
}

async function capture(origin, route, cookie) {
  const response = await fetch(new URL(route.path, origin), {
    redirect: 'manual',
    headers: route.withCart && cookie ? { cookie } : {},
  });
  const body = await response.text();
  return [
    `# ${route.path}`,
    `status: ${response.status}`,
    normalizeHeaders(response.headers),
    '',
    normalizeHtml(body),
  ].join('\n');
}

/** First differing line, with context — a full diff of a 400-line document
 *  buries the signal. */
function firstDifference(expected, actual) {
  const a = expected.split('\n');
  const b = actual.split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) {
      return [
        `  line ${i + 1}:`,
        `    baseline: ${a[i] ?? '<end of file>'}`,
        `    current:  ${b[i] ?? '<end of file>'}`,
      ].join('\n');
    }
  }
  return '  (files differ only in trailing content)';
}

const [, , portArg, ...flags] = process.argv;
const origin = `http://127.0.0.1:${portArg}`;
const update = flags.includes('--update');

await mkdir(BASELINE_DIR, { recursive: true });

const cookie = await cartCookie(origin);

const failures = [];
for (const route of ROUTES) {
  const current = await capture(origin, route, cookie);
  const file = join(BASELINE_DIR, `${route.name}.txt`);

  if (update) {
    await writeFile(file, current);
    console.log(`captured ${route.name}`);
    continue;
  }

  let baseline;
  try {
    baseline = await readFile(file, 'utf8');
  } catch {
    failures.push(`${route.name}: no baseline at ${file} (capture it with --update)`);
    continue;
  }
  if (baseline !== current) {
    failures.push(`${route.name} changed:\n${firstDifference(baseline, current)}`);
  }
}

if (failures.length > 0) {
  console.error('Storefront equivalence failed.\n');
  console.error(failures.join('\n\n'));
  console.error(
    '\nIf the change is intentional, review it like source and re-capture with:',
  );
  console.error('  npm run test:storefront-equivalence -- --update\n');
  process.exit(1);
}

if (!update) console.log(`storefront equivalence: ${ROUTES.length} routes match`);
