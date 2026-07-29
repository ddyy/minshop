import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// Deliberately .mjs: reads source files, and tsconfig.compilerOptions.types is
// pinned to the Cloudflare types. Same reason as boundary.test.mjs.
//
// These assertions exist because the HTML baselines cannot see them. The prose
// scale is a CSS-only contract: tokenizing it changes no markup at all, so the
// equivalence gate passes whether the rules read a token, read the wrong token,
// or lost their fallback.

const theme = readFileSync('src/styles/theme.css', 'utf8');
const global = readFileSync('src/styles/global.css', 'utf8');

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
    expect(global).toContain(`${property}: var(${token},`);
  });

  it.each(PROSE_RULES)('keeps today\'s value as the fallback for %s (%s)', (_property, token, literal) => {
    // A store may replace theme.css wholesale with a design system's tokens and
    // omit one of these. That must degrade to the current design, not to an
    // unstyled heading.
    expect(global).toContain(`var(${token}, ${literal})`);
  });

  it.each(PROSE_RULES)('declares %s → %s in the store-owned theme', (_property, token) => {
    expect(theme).toContain(`${token}:`);
  });

  it('lets a page layout preset still win over the theme measure', () => {
    // --page-measure is set per page by pageLayoutStyle from the merchant's
    // chosen preset. A theme token must not override an explicit choice of a
    // wide or centred layout, so it sits in the INNER fallback position.
    expect(global).toContain('max-width: var(--page-measure, var(--prose-measure, 48rem));');
  });

  it('keeps the prose tokens outside @theme', () => {
    // They are consumed directly by core CSS and define no Tailwind utility
    // namespace; inside @theme they would imply a utility-token role.
    const themeBlock = theme.slice(theme.indexOf('@theme'), theme.indexOf('}', theme.indexOf('@theme')));

    expect(themeBlock).not.toContain('--prose-');
    expect(theme).toContain(':root {');
  });

  it('leaves the rest of global.css alone', () => {
    // Only the content-page scale is tokenized. Admin chrome and structural
    // rules stay core-owned and hardcoded — tokenizing them would enlarge the
    // contract for no customization benefit.
    expect(global).toContain('[data-admin-nav-toggle]');
    expect(global).toContain('[data-gallery]');
  });
});
