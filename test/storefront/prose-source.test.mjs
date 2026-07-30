import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// Deliberately .mjs: reads source files, and tsconfig.compilerOptions.types is
// pinned to the Cloudflare types. Same reason as boundary.test.mjs.
//
// These assertions exist because the HTML baselines cannot see them. The prose
// scale is a CSS-only contract: tokenizing it changes no markup at all, so the
// equivalence gate passes whether the rules read a token, read the wrong token,
// or lost their fallback.

import { discoverThemeIds, THEMES_DIR } from '../../scripts/themes.mjs';

const global = readFileSync('src/styles/global.css', 'utf8');
// Structural rules moved to base.css so the Admin entry can share them without
// inheriting the set import. Tests that assert on rules read the structural
// file; tests about IMPORT ORDER still read the entry point.
const structural = readFileSync('src/styles/base.css', 'utf8');
const override = readFileSync('src/styles/overrides.css', 'utf8');

// Every SHIPPED theme must declare the tokens the core prose rules read. The
// override file is checked for the opposite property: that it is allowed to
// declare nothing. Tokens moved into the themes so selecting one brings its
// design with it; requiring them here too would forbid an empty override.
const themes = discoverThemeIds();
const themeTokens = themes.map((id) => [id, readFileSync(`${THEMES_DIR}/${id}/tokens.css`, 'utf8')]);

/** property → [token, today's literal] */
const PROSE_RULES = [
  ['line-height', '--prose-leading', '1.75'],
  ['font-size', '--prose-h1-size', '2.25rem'],
  ['letter-spacing', '--prose-h1-tracking', '-0.02em'],
  ['font-size', '--prose-h2-size', '1.5rem'],
  ['letter-spacing', '--prose-h2-tracking', '-0.01em'],
  ['font-size', '--prose-h3-size', '1.125rem'],
];

describe('the content-page prose scale', () => {
  it.each(PROSE_RULES)('reads %s from %s', (property, token) => {
    expect(structural).toContain(`${property}: var(${token},`);
  });

  it.each(PROSE_RULES)('keeps today\'s value as the fallback for %s (%s)', (_property, token, literal) => {
    // A store may replace theme.css wholesale with a design system's tokens and
    // omit one of these. That must degrade to the current design, not to an
    // unstyled heading.
    expect(structural).toContain(`var(${token}, ${literal})`);
  });

  it('ships at least one theme to validate', () => {
    expect(themes.length).toBeGreaterThan(0);
  });

  it.each(PROSE_RULES)('every shipped theme declares %s → %s', (_property, token) => {
    for (const [id, css] of themeTokens) {
      expect(css, `theme "${id}" is missing ${token}`).toContain(`${token}:`);
    }
  });

  it('lets the merchant override file declare nothing at all', () => {
    // An empty override is the normal state: it means the store uses its set's
    // tokens unchanged. Requiring tokens here would make that state fail.
    const declarations = override.match(/--[a-z-]+\s*:/g) ?? [];

    expect(declarations).toEqual([]);
  });

  it('applies the merchant override after the active set', () => {
    // Order is the whole contract: the set supplies the design, the store's own
    // values win over it.
    expect(global.indexOf('#theme-css')).toBeLessThan(
      global.indexOf('./overrides.css'),
    );
  });

  it('lets a page layout preset still win over the theme measure', () => {
    // --page-measure is set per page by pageLayoutStyle from the merchant's
    // chosen preset. A theme token must not override an explicit choice of a
    // wide or centred layout, so it sits in the INNER fallback position.
    expect(structural).toContain('max-width: var(--page-measure, var(--prose-measure, 48rem));');
  });

  it.each(themes)('keeps %s prose tokens outside @theme', (id) => {
    // They are consumed directly by core CSS and define no Tailwind utility
    // namespace; inside @theme they would imply a utility-token role.
    const css = readFileSync(`${THEMES_DIR}/${id}/tokens.css`, 'utf8');
    const block = css.slice(css.indexOf('@theme'), css.indexOf('}', css.indexOf('@theme')));

    expect(block).not.toContain('--prose-');
    expect(css).toContain(':root {');
  });

  it('leaves the rest of global.css alone', () => {
    // Only the content-page scale is tokenized. Admin chrome and structural
    // rules stay core-owned and hardcoded — tokenizing them would enlarge the
    // contract for no customization benefit.
    expect(structural).toContain('[data-admin-nav-toggle]');
    expect(structural).toContain('[data-gallery]');
  });
});

// The semantic @theme surface has NO fallback story: these tokens GENERATE the
// utilities, so omitting one doesn't degrade to the default design — it stops
// `bg-brand` (etc.) from being emitted at all, silently. Unlike the prose and
// container properties above, completeness is the contract.
const REQUIRED_THEME_TOKENS = [
  '--color-brand',
  '--color-brand-hover',
  '--color-ink',
  '--color-accent',
  '--color-paper',
  '--color-line',
  '--color-surface',
  '--color-muted',
  '--color-faint',
  '--color-on-brand',
  '--font-sans',
  '--font-serif',
  '--radius-md',
  '--radius-lg',
];

/** The concatenated contents of every @theme block, comments stripped FIRST —
 *  a token named in a comment, or declared in :root, generates nothing, so it
 *  must not satisfy the contract. Brace-matched rather than regexed to the
 *  first `}` so a nested block cannot truncate the scan. */
function themeBlockDeclarations(css) {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let out = '';
  let from = 0;
  for (;;) {
    const at = noComments.indexOf('@theme', from);
    if (at === -1) break;
    const open = noComments.indexOf('{', at);
    if (open === -1) break;
    let depth = 1;
    let end = open + 1;
    while (end < noComments.length && depth > 0) {
      if (noComments[end] === '{') depth += 1;
      else if (noComments[end] === '}') depth -= 1;
      end += 1;
    }
    out += noComments.slice(open + 1, end - 1);
    from = end;
  }
  return out;
}

describe('the semantic @theme token surface', () => {
  it.each(themes)('%s declares every required token INSIDE @theme', (id) => {
    // Only an @theme declaration generates utilities. The same token in :root
    // (or quoted in a comment) leaves bg-brand and friends unemitted, which is
    // exactly the silent failure this contract exists to prevent — so the
    // search is scoped to the parsed block, not the file.
    const declarations = themeBlockDeclarations(readFileSync(`${THEMES_DIR}/${id}/tokens.css`, 'utf8'));
    for (const token of REQUIRED_THEME_TOKENS) {
      expect(declarations, `theme "${id}" does not declare ${token} inside @theme`).toContain(
        `${token}:`,
      );
    }
  });

  it('rejects a token that is present but outside @theme', () => {
    // The parser's own contract: :root declarations and comment mentions must
    // not count.
    const fixture = `
      /* --color-brand: #fff is documented here */
      :root { --color-brand: #abc; }
      @theme { --color-ink: #000; }
    `;
    const declarations = themeBlockDeclarations(fixture);
    expect(declarations).toContain('--color-ink:');
    expect(declarations).not.toContain('--color-brand');
  });
});

/** property → [token, today's literal] for the page container. */
const CONTAINER_RULES = [
  ['max-width', '--page-max', '72rem'],
  ['padding-inline', '--page-pad-x', '1.5rem'],
  ['padding-block', '--page-pad-y', '3rem'],
];

describe('the page container', () => {
  it.each(CONTAINER_RULES)('reads %s from %s with a literal fallback', (property, token, literal) => {
    // Same contract as the prose scale: a theme that declares none of these
    // renders exactly as the default did, and one that declares some inherits
    // the rest. Without the fallbacks, dropping a token would collapse the
    // page to zero width or lose its padding entirely.
    expect(structural).toContain(`${property}: var(${token}, ${literal})`);
  });

  it.each(themes)('%s declares the container tokens it wants', (id) => {
    // Not required to declare all three — the fallbacks cover omissions — but a
    // set that declares none is relying on defaults, which is worth seeing.
    const css = readFileSync(`${THEMES_DIR}/${id}/tokens.css`, 'utf8');
    const declared = CONTAINER_RULES.filter(([, token]) => css.includes(`${token}:`));

    expect(declared.length).toBeGreaterThan(0);
  });

  it('applies the container through one core rule, not per-template classes', () => {
    // If a template hardcoded its own width the tokens would be decorative.
    const layout = readFileSync('src/layouts/Layout.astro', 'utf8');

    expect(layout).toContain('<main class="page-shell">');
    expect(structural).toContain('.page-shell {');
  });
});
