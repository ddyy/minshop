#!/usr/bin/env node
/**
 * Storefront boundary check.
 *
 * A guardrail, not a security sandbox: these files are ordinary application
 * source with full build-time authority. What it buys is a fast, specific error
 * when a presentation edit reaches for something that is not presentation —
 * a database module, a runtime binding, request state.
 *
 * Two policies, selected by path, because store-owned templates and core
 * controls have opposite jobs:
 *
 *   store-owned templates  deny-by-default allowlist. They compose models and
 *                          controls and nothing else.
 *   core controls          denylist. They exist to ENCAPSULATE core behavior,
 *                          so they may use pure helpers; what they must never
 *                          do is read bindings, query D1, or touch checkout.
 *
 * Both reject request-context access, which is what keeps every exposed piece
 * renderable from props alone.
 *
 * Usage: node scripts/check-storefront.mjs [dir...]
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const CONTROLS_DIR = 'src/features/storefront/controls';

const DEFAULT_PATHS = [
  'src/storefront',
  'test/storefront/fixtures',
  CONTROLS_DIR,
];

/** Request-context members neither policy allows. `Astro.props`/`Astro.slots`
 *  are the intended component contract, so the match is member-by-member rather
 *  than a ban on the `Astro.` prefix. */
const FORBIDDEN_CONTEXT = ['locals', 'request', 'url', 'response'];

/** Store-owned templates may import only these. Anything else — including
 *  src/config.ts, which is not a database module but does read bindings — is
 *  rejected by absence, not by listing. */
function templateImportAllowed(specifier, fileDir, rootDir) {
  if (specifier.startsWith('.')) {
    const resolved = join(fileDir, specifier);
    // Inside the same candidate root (its own primitives, ui/, partials).
    if (!relative(rootDir, resolved).startsWith('..')) return true;
    // The two documented upstream entry points.
    if (resolved.startsWith('src/features/storefront/models')) return true;
    if (resolved.startsWith(CONTROLS_DIR)) return true;
    return false;
  }
  return false;
}

/** Core controls may not reach these, directly or transitively. */
const CONTROL_DENIED = [
  { test: /^cloudflare:workers$/, why: 'runtime bindings' },
  { test: /(^|\/)config(\.ts)?$/, why: 'binding-aware config (use a pure helper or a model field)' },
  { test: /features\/(products|orders|categories|settings|customers|pages|media)\/db/, why: 'a D1 query module' },
  { test: /features\/(payments|refunds|auth|secrets|cart|shipping)/, why: 'commerce, auth, or secret code' },
  { test: /features\/storage/, why: 'a storage adapter' },
  { test: /pages\/admin|components\/(Admin|Revenue|Secret)/, why: 'Admin code' },
];

const IMPORT_RE = /(?:^|\n)\s*import\s+(?:type\s+)?[^'"]*from\s+['"]([^'"]+)['"]/g;
const BARE_IMPORT_RE = /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g;

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    // An allowed scan directory that does not exist yet is not an error: the
    // check is wired into verify before every directory it guards exists.
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (/\.(astro|ts|tsx|js|mjs)$/.test(entry.name)) yield full;
  }
}

function importsOf(source) {
  const found = [];
  for (const re of [IMPORT_RE, BARE_IMPORT_RE]) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(source)) !== null) found.push(match[1]);
  }
  return found;
}

const problems = [];

/**
 * Comments are stripped before scanning. Storefront files are expected to
 * DOCUMENT their boundary ("never reads Astro.locals"), and matching that prose
 * would fail exactly the components that explain themselves best.
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // Not `://`, so protocol-relative URLs and https: literals survive.
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

async function checkFile(file, rootDir, policy) {
  const source = stripComments(await readFile(file, 'utf8'));
  const fileDir = file.slice(0, file.lastIndexOf('/'));

  for (const member of FORBIDDEN_CONTEXT) {
    if (new RegExp(`\\bAstro\\.${member}\\b`).test(source)) {
      problems.push(
        `${file}: reads Astro.${member}. Request-derived values must arrive ` +
          `through a typed model, so the component renders from props alone.`,
      );
    }
  }

  for (const specifier of importsOf(source)) {
    if (policy === 'template') {
      if (!templateImportAllowed(specifier, fileDir, rootDir)) {
        problems.push(
          `${file}: imports "${specifier}". Store-owned templates may import ` +
            `only storefront models (as types), documented controls from ` +
            `${CONTROLS_DIR}/, and files inside ${rootDir}/.`,
        );
      }
      continue;
    }

    const denied = CONTROL_DENIED.find((rule) => rule.test.test(specifier));
    if (denied) {
      problems.push(
        `${file}: imports "${specifier}" — ${denied.why}. Core controls may use ` +
          `pure helpers, but never bindings, D1, storage, checkout, or Admin.`,
      );
    }
  }
}

const paths = process.argv.slice(2);
for (const root of paths.length > 0 ? paths : DEFAULT_PATHS) {
  // A root named `controls` takes the core-control policy. Matching the
  // directory name rather than one hardcoded path lets the same checker be
  // pointed at a candidate template set or a future preset.
  const policy = /(^|\/)controls$/.test(root.replace(/\/+$/, '')) ? 'control' : 'template';
  for await (const file of walk(root)) {
    await checkFile(file, root.replace(/\/+$/, ''), policy);
  }
}

if (problems.length > 0) {
  console.error('Storefront boundary check failed:\n');
  for (const problem of problems) console.error(`  ${problem}\n`);
  process.exit(1);
}

console.log('storefront boundary: ok');
