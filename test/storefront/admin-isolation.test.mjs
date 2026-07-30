import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// Deliberately .mjs: reads source files, like boundary.test.mjs.
//
// Admin is upstream chrome and must stay readable under ANY theme.
// It once shared global.css, so Studio's near-black paper and film-grain body
// texture landed behind every authenticated Admin page while core Admin text
// stayed hardcoded dark — about 1.1:1. These assertions pin the isolation:
// the Admin stylesheet entry must never pull in the active theme, and the
// layout must use it. The compiled-CSS check (scripts/check-built-css.mjs)
// verifies the same property in the built output.

import { discoverThemeIds } from '../../scripts/themes.mjs';
import { GENERATED_CSS_DIR, writeThemeArtifacts } from '../../scripts/theme-css.mjs';

const admin = readFileSync('src/styles/admin.css', 'utf8');
const layout = readFileSync('src/layouts/AdminLayout.astro', 'utf8');

describe('the Admin stylesheet entry', () => {
  it('never imports the active theme or the merchant override', () => {
    // The theme import is what turned Admin dark; the merchant override is
    // excluded on the same principle — rebranding changes the storefront,
    // Admin looks the same in every store.
    expect(admin).not.toContain('#theme-css');
    expect(admin).not.toContain('./overrides.css');
  });

  it('declares its own stable tokens for everything Admin renders with', () => {
    for (const token of [
      '--color-brand:',
      '--color-brand-hover:',
      '--color-ink:',
      '--color-accent:',
      '--color-paper:',
      '--color-line:',
      '--color-surface:',
      '--color-muted:',
      '--color-faint:',
      '--color-on-brand:',
    ]) {
      expect(admin, `admin.css is missing ${token}`).toContain(token);
    }
  });

  it('shares the structural rules through base.css', () => {
    expect(admin).toContain('./base.css');
  });

  it('excludes every discovered theme from its Tailwind scan', () => {
    // Deterministic and idempotent, so generating here is safe even while a
    // dev server runs — identical bytes produce no write at all.
    writeThemeArtifacts();
    const exclusions = readFileSync(`${GENERATED_CSS_DIR}/_admin.css`, 'utf8');
    for (const id of discoverThemeIds()) {
      expect(exclusions).toContain(`@source not "../../themes/${id}";`);
    }
    expect(admin).toContain('./themes/_admin.css');
  });
});

describe('AdminLayout', () => {
  it('imports the Admin entry, not the storefront one', () => {
    expect(layout).toContain("import '../styles/admin.css';");
    expect(layout).not.toContain("import '../styles/global.css'");
  });

  it('sets the page colours from Admin tokens on <body>', () => {
    // Raw grays deeper in the layout are fine — Admin's tokens are frozen
    // light, so gray-on-paper is always readable there. What must hold is
    // that the page ground itself reads Admin's own paper and ink: dark-set
    // leakage showed up exactly here, as set-controlled bg-paper under
    // hardcoded dark text.
    expect(layout).toContain('bg-paper text-ink antialiased');
  });
});

describe('standalone test commands', () => {
  it('vitest.config.ts generates the artifacts the root tsconfig extends', () => {
    // tsconfig.json extends generated tsconfig.theme.json. On a fresh
    // archive, `npm run test:storefront-contract` dies collecting tests unless
    // the config itself generates the artifacts first.
    const config = readFileSync('vitest.config.ts', 'utf8');
    expect(config.indexOf('writeThemeArtifacts()')).toBeGreaterThan(-1);
    expect(config.indexOf('writeThemeArtifacts()')).toBeLessThan(
      config.indexOf('getViteConfig('),
    );
  });
});
