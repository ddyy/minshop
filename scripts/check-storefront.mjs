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
 * Checking is TRANSITIVE. A control that imports a local helper which imports
 * `cloudflare:workers` is exactly as binding-aware as one that imports it
 * directly, and inspecting only the first hop would let that through. The
 * reported error names the whole chain, because "this control is binding-aware"
 * is not actionable without knowing which hop introduced it.
 *
 * Usage: node scripts/check-storefront.mjs [dir...]
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, normalize, relative } from 'node:path';

const CONTROLS_DIR = 'src/features/storefront/controls';
const MODELS_MODULE = 'src/features/storefront/models.ts';

const DEFAULT_PATHS = ['src/storefront', 'test/storefront/fixtures', CONTROLS_DIR];

/** Request-context members neither policy allows. `Astro.props`/`Astro.slots`
 *  are the intended component contract, so the match is member-by-member rather
 *  than a ban on the `Astro.` prefix. */
const FORBIDDEN_CONTEXT = ['locals', 'request', 'url', 'response'];

/**
 * Dependencies nothing in the storefront graph may reach, directly or through
 * any number of local hops. Matched against RESOLVED repo-relative paths, so a
 * relative specifier cannot dodge the rule by its shape.
 */
const DENIED_PATHS = [
  { prefix: 'src/config', why: 'binding-aware config (use a pure helper or a model field)' },
  { prefix: 'src/features/products/db', why: 'a D1 query module' },
  { prefix: 'src/features/orders', why: 'order data' },
  { prefix: 'src/features/categories/db', why: 'a D1 query module' },
  { prefix: 'src/features/settings/db', why: 'a D1 query module' },
  { prefix: 'src/features/customers', why: 'customer data' },
  { prefix: 'src/features/pages/db', why: 'a D1 query module' },
  { prefix: 'src/features/media/db', why: 'a D1 query module' },
  { prefix: 'src/features/navigation/db', why: 'a D1 query module' },
  { prefix: 'src/features/payments', why: 'payment code' },
  { prefix: 'src/features/refunds', why: 'refund code' },
  { prefix: 'src/features/auth', why: 'authentication code' },
  { prefix: 'src/features/secrets', why: 'secret material' },
  { prefix: 'src/features/cart', why: 'cart state' },
  { prefix: 'src/features/shipping', why: 'shipping code' },
  { prefix: 'src/features/storage', why: 'a storage adapter' },
  { prefix: 'src/pages/admin', why: 'Admin routes' },
  { prefix: 'src/middleware', why: 'request middleware' },
];

const DENIED_MODULES = [
  { name: 'cloudflare:workers', why: 'runtime bindings' },
  { name: 'node:fs', why: 'filesystem access' },
];

const SOURCE_EXTENSIONS = ['.astro', '.ts', '.tsx', '.mjs', '.js'];

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

/**
 * Every import form that can pull in a dependency, with its kind retained:
 * `import type` is materially weaker than a value import (it disappears at
 * build time), and the template allowlist depends on that distinction.
 */
function importsOf(source) {
  const found = [];
  const add = (specifier, typeOnly) => found.push({ specifier, typeOnly });

  const patterns = [
    // import x from 'y' / import type { X } from 'y'
    { re: /(?:^|[\s;])import\s+(type\s+)?[^'"();]*?\s*from\s*['"]([^'"]+)['"]/g, type: 1, spec: 2 },
    // import 'y'
    { re: /(?:^|[\s;])import\s+['"]([^'"]+)['"]/g, type: null, spec: 1 },
    // await import('y')
    { re: /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, type: null, spec: 1 },
    // export { x } from 'y' / export * from 'y' / export type { X } from 'y'
    {
      re: /(?:^|[\s;])export\s+(type\s+)?(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s*from\s*['"]([^'"]+)['"]/g,
      type: 1,
      spec: 2,
    },
  ];

  for (const { re, type, spec } of patterns) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(source)) !== null) {
      add(match[spec], type !== null && Boolean(match[type]));
    }
  }
  return found;
}

/** Resolve a relative specifier to an actual file, repo-relative. */
async function resolveLocal(specifier, fromFile) {
  if (!specifier.startsWith('.')) return null;
  const base = normalize(join(dirname(fromFile), specifier));
  const candidates = [
    base,
    ...SOURCE_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...SOURCE_EXTENSIONS.map((extension) => join(base, `index${extension}`)),
  ];
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // Keep trying; an unresolvable specifier is reported by the caller.
    }
  }
  return null;
}

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
    else if (SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) yield full;
  }
}

const problems = [];
const describeChain = (chain) => chain.join('\n      → ');

function checkDeniedDependency(specifier, resolved, chain) {
  // Subpath-aware: an exact match would let `node:fs/promises` or
  // `cloudflare:workers/foo` through while banning the bare module.
  const module = DENIED_MODULES.find(
    (rule) => specifier === rule.name || specifier.startsWith(`${rule.name}/`),
  );
  if (module) {
    problems.push(
      `${describeChain(chain)}\n    imports "${specifier}" — ${module.why}.\n` +
        `    Nothing in the storefront graph may reach bindings, D1, storage, checkout, or Admin.`,
    );
    return;
  }
  if (!resolved) return;
  const denied = DENIED_PATHS.find(
    (rule) => resolved === rule.prefix || resolved.startsWith(`${rule.prefix}.`) || resolved.startsWith(`${rule.prefix}/`),
  );
  if (denied) {
    problems.push(
      `${describeChain(chain)}\n    reaches "${resolved}" — ${denied.why}.\n` +
        `    Core controls may use pure helpers, but never bindings, D1, storage, checkout, or Admin.`,
    );
  }
}

function checkRequestContext(file, source) {
  for (const member of FORBIDDEN_CONTEXT) {
    if (new RegExp(`\\bAstro\\.${member}\\b`).test(source)) {
      problems.push(
        `${file}\n    reads Astro.${member}. Request-derived values must arrive through a\n` +
          `    typed model, so the component renders from props alone.`,
      );
    }
  }
}

/**
 * Store-owned templates may import only: storefront models (type-only, since a
 * value import would pull runtime code into a presentation file), documented
 * controls, and files inside their own candidate root.
 */
function checkTemplateImport({ specifier, typeOnly }, resolved, file, rootDir) {
  if (resolved && !relative(rootDir, resolved).startsWith('..')) return;
  if (resolved === MODELS_MODULE) {
    if (!typeOnly) {
      problems.push(
        `${file}\n    imports storefront models as a value. Use \`import type\`: the model is a\n` +
          `    shape, and a value import puts runtime code in a presentation file.`,
      );
    }
    return;
  }
  if (resolved && resolved.startsWith(`${CONTROLS_DIR}/`)) return;

  problems.push(
    `${file}\n    imports "${specifier}". Store-owned templates may import only storefront\n` +
      `    models (as types), documented controls from ${CONTROLS_DIR}/, and files\n` +
      `    inside ${rootDir}/.`,
  );
}

/**
 * Walks one entry file's whole local dependency graph. Direct imports are held
 * to the root's policy; every file reached, at any depth, is held to the denied
 * dependency and request-context rules.
 */
async function checkEntry(entry, rootDir, policy) {
  const seen = new Set();
  const queue = [{ file: entry, chain: [entry] }];

  while (queue.length > 0) {
    const { file, chain } = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);

    let source;
    try {
      source = stripComments(await readFile(file, 'utf8'));
    } catch {
      continue;
    }

    checkRequestContext(file, source);

    for (const imported of importsOf(source)) {
      const resolved = await resolveLocal(imported.specifier, file);
      checkDeniedDependency(imported.specifier, resolved, chain);

      if (policy === 'template' && file === entry) {
        checkTemplateImport(imported, resolved, file, rootDir);
      }

      // A type-only import contributes no runtime dependency, but its module is
      // still followed: a type re-exported from a binding-aware file signals the
      // model boundary is being bypassed.
      if (resolved && !seen.has(resolved)) {
        queue.push({ file: resolved, chain: [...chain, resolved] });
      }
    }
  }
}

const paths = process.argv.slice(2);
for (const rawRoot of paths.length > 0 ? paths : DEFAULT_PATHS) {
  const root = rawRoot.replace(/\/+$/, '');
  // A root named `controls` takes the core-control policy. Matching the
  // directory name rather than one hardcoded path lets the same checker be
  // pointed at a candidate template set or a future preset.
  const policy = /(^|\/)controls$/.test(root) ? 'control' : 'template';
  for await (const file of walk(root)) {
    await checkEntry(file, root, policy);
  }
}

if (problems.length > 0) {
  console.error('Storefront boundary check failed:\n');
  for (const problem of problems) console.error(`  ${problem}\n`);
  process.exit(1);
}

console.log('storefront boundary: ok');
