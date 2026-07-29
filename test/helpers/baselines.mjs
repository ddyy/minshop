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
 * Every surface that renders a product card, plus the shell routes an extraction
 * could disturb. Names become file names, so they stay stable across releases.
 */
export const ROUTES = [
  { name: 'home', path: '/' },
  { name: 'catalog', path: '/products' },
  { name: 'catalog-sorted-page2', path: '/products?sort=price&dir=asc&page=2' },
  { name: 'category', path: '/categories/apparel' },
  { name: 'search', path: '/search?q=sample' },
  { name: 'search-empty', path: '/search?q=zzzznomatch' },
  { name: 'product-detail', path: '/products/sample-tee' },
  { name: 'not-found', path: '/no-such-page' },
];

async function capture(origin, route) {
  const response = await fetch(new URL(route.path, origin), { redirect: 'manual' });
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

const failures = [];
for (const route of ROUTES) {
  const current = await capture(origin, route);
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
