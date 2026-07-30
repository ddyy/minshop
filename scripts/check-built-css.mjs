#!/usr/bin/env node
/**
 * Post-build stylesheet assertions. Run after `astro build`.
 *
 * Proves two properties of dist/ that every other gate is blind to, because
 * markup-equivalence baselines never look at compiled CSS and a build that
 * violates both still exits 0:
 *
 *  1. Set scoping — the active set's utilities are present and every inactive
 *     set's are absent. This is what the generated `@source not` exclusions
 *     and `source(none)` scoping exist to guarantee; break either and the
 *     stylesheet silently bloats with (or leaks styling from) sets the build
 *     did not select. Found the hard way: Tailwind's default project-wide
 *     scan was re-acquiring the default set's classes from the rendered HTML
 *     in test/baselines/*.txt.
 *
 *  2. Admin isolation — the Admin entry keeps its own stable palette and
 *     carries no set's utilities and no set's paper colour. Admin must stay
 *     readable under ANY storefront design (a dark set once themed
 *     authenticated Admin to ~1.1:1).
 *
 * Sentinels are DERIVED, not hardcoded: for each set, the class names that
 * appear in that set's templates and nowhere else (not in core, not in a
 * sibling set). Derivation keeps the check honest for a generated store's
 * merchant-owned set, which upstream cannot know a sentinel for.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { SETS_DIR, discoverSetIds, resolveStorefrontSet } from './storefront-set.mjs';

const root = process.cwd();

// ---------------------------------------------------------------------------
// Collect class names per source area.

const CLASS_ATTR = /class(?:Name)?=(?:"([^"]*)"|\{`([^`]*)`\})/g;
// A candidate must be a plain, unconditional utility literal — no template
// interpolation fragments, no quotes from ternaries.
const PLAIN_CLASS = /^[a-z][a-zA-Z0-9:/\[\]().,%_'-]*$/;

function classesIn(file) {
  const out = new Set();
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(CLASS_ATTR)) {
    for (const token of (match[1] ?? match[2] ?? '').split(/\s+/)) {
      if (token && PLAIN_CLASS.test(token) && !token.includes('$')) out.add(token);
    }
  }
  return out;
}

function classesUnder(dir) {
  const out = new Set();
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const path = join(d, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (/\.(astro|ts|tsx)$/.test(entry.name)) for (const c of classesIn(path)) out.add(c);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

/** Every byte under dir (skipping other-set dirs when asked), for raw
 *  substring tests. Tailwind's scanner reads WHOLE files, not just class
 *  attributes — a token counts as "unique to a set" only if it appears
 *  nowhere else in src in any form, or the compiled output will legitimately
 *  contain it in every build and the check cries wolf. */
function rawContentUnder(dir, { skipDirs = [] } = {}) {
  const skips = skipDirs.map((d) => resolve(d));
  let out = '';
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const path = join(d, entry.name);
      if (entry.isDirectory()) {
        if (skips.some((s) => resolve(path) === s)) continue;
        walk(path);
        continue;
      }
      out += readFileSync(path, 'utf8');
      out += '\n';
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

/** The compiled form of a class name inside a CSS selector. */
function cssEscaped(name) {
  return name.replace(/[^a-zA-Z0-9-]/g, (ch) => `\\${ch}`);
}

// ---------------------------------------------------------------------------
// Derive per-set sentinel candidates.

const ids = discoverSetIds(root);
const active = resolveStorefrontSet(root);
const setClasses = new Map(ids.map((id) => [id, classesUnder(resolve(root, SETS_DIR, id))]));
// One haystack per set: all of src EXCEPT that set's own directory.
const srcExceptSet = new Map(
  ids.map((id) => [
    id,
    rawContentUnder(resolve(root, 'src'), { skipDirs: [resolve(root, SETS_DIR, id)] }),
  ]),
);

function uniqueTo(id) {
  const haystack = srcExceptSet.get(id);
  return [...setClasses.get(id)].filter((c) => !haystack.includes(c));
}

// ---------------------------------------------------------------------------
// Read the built stylesheets.

const distDir = resolve(root, 'dist');
if (!existsSync(distDir)) {
  console.error('check-built-css: no dist/. Run `astro build` first.');
  process.exit(1);
}
const cssFiles = [];
const findCss = (d) => {
  for (const entry of readdirSync(d, { withFileTypes: true })) {
    const path = join(d, entry.name);
    if (entry.isDirectory()) findCss(path);
    else if (entry.name.endsWith('.css')) cssFiles.push(path);
  }
};
findCss(distDir);
if (cssFiles.length === 0) {
  console.error('check-built-css: dist/ contains no stylesheets.');
  process.exit(1);
}
const css = new Map(cssFiles.map((f) => [f, readFileSync(f, 'utf8')]));

const failures = [];

// 1a. The active set is actually in the output.
const activeCandidates = uniqueTo(active.id);
const activeHits = activeCandidates.filter((c) =>
  cssFiles.some((f) => css.get(f).includes(cssEscaped(c))),
);
if (activeCandidates.length === 0) {
  // No silent caps: a set whose every class overlaps its siblings cannot be
  // sentinel-checked, and pretending otherwise would report coverage that
  // does not exist.
  console.log(
    `check-built-css: NOTE — set "${active.id}" has no unique class; presence not verifiable.`,
  );
} else if (activeHits.length === 0) {
  failures.push(
    `active set "${active.id}": none of its ${activeCandidates.length} unique utilities appear in any built stylesheet — its templates are not being scanned.`,
  );
}

// 1b. No inactive set leaks in.
const storefrontFiles = new Set(
  activeHits.length > 0
    ? cssFiles.filter((f) => activeHits.some((c) => css.get(f).includes(cssEscaped(c))))
    : [],
);
for (const id of ids) {
  if (id === active.id) continue;
  for (const c of uniqueTo(id)) {
    for (const f of cssFiles) {
      if (css.get(f).includes(cssEscaped(c))) {
        failures.push(
          `inactive set "${id}": utility "${c}" leaked into ${relative(root, f)} — its exclusion is broken.`,
        );
      }
    }
  }
}

// 2. Admin isolation: every stylesheet that is not the storefront entry's must
//    keep Admin's own paper and reject the active set's.
const adminSource = readFileSync(resolve(root, 'src/styles/admin.css'), 'utf8');
const adminPaper = adminSource.match(/--color-paper:\s*([^;]+);/)?.[1].trim();
const activeTheme = readFileSync(resolve(root, SETS_DIR, active.id, 'theme.css'), 'utf8');
const activePaper = activeTheme.match(/--color-paper:\s*([^;]+);/)?.[1].trim();
if (!adminPaper) failures.push('src/styles/admin.css declares no --color-paper.');
for (const f of cssFiles) {
  if (storefrontFiles.has(f)) continue;
  const body = css.get(f);
  if (!body.includes('--color-paper:')) continue; // not a page-level entry
  if (adminPaper && !body.includes(`--color-paper:${adminPaper}`)) {
    failures.push(`${relative(root, f)}: Admin entry lost its own paper (${adminPaper}).`);
  }
  if (activePaper && activePaper !== adminPaper && body.includes(`--color-paper:${activePaper}`)) {
    failures.push(
      `${relative(root, f)}: carries the active set's paper (${activePaper}) — the set theme reached Admin.`,
    );
  }
}

if (failures.length > 0) {
  console.error(`check-built-css: FAILED for active set "${active.id}"\n`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
console.log(
  `check-built-css: ok — active "${active.id}" present (${activeHits.length} sentinel${activeHits.length === 1 ? '' : 's'}), ` +
    `${ids.length - 1} inactive set${ids.length === 2 ? '' : 's'} excluded, Admin isolated, across ${cssFiles.length} stylesheet${cssFiles.length === 1 ? '' : 's'}.`,
);
