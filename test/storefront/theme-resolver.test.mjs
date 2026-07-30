import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  RESERVED_THEME_IDS,
  discoverThemeIds,
  isValidThemeId,
  normalizeThemeId,
  resolveTheme,
  themePath,
} from '../../scripts/themes.mjs';

// .mjs: reads the filesystem, and tsconfig.compilerOptions.types is pinned to
// the Cloudflare types. Same reason as boundary.test.mjs.

const roots = [];
function fixture(ids, config) {
  const root = mkdtempSync(join(tmpdir(), 'theme-resolver-'));
  roots.push(root);
  for (const id of ids) mkdirSync(join(root, 'src/themes', id), { recursive: true });
  if (config !== undefined) writeFileSync(join(root, 'theme.config.json'), config);
  return root;
}

afterEach(() => {
  delete process.env.THEME;
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

describe('theme ids', () => {
  it.each(['default', 'studio', 'acme', 'acme-holiday', 'shop2'])('accepts %s', (id) => {
    expect(isValidThemeId(id)).toBe(true);
  });

  it.each([
    ['..', 'traversal'],
    ['../features', 'traversal'],
    ['Acme', 'uppercase'],
    ['acme store', 'spaces'],
    ['-acme', 'leading hyphen'],
    ['acme-', 'trailing hyphen'],
    ['acme--x', 'doubled hyphen'],
    ['', 'empty'],
  ])('rejects %s (%s)', (id) => {
    expect(isValidThemeId(id)).toBe(false);
  });

  it('normalizes a free-form store name into an id', () => {
    expect(normalizeThemeId('Acme Supply Co.')).toBe('acme-supply-co');
    expect(normalizeThemeId('  Bob & Sons  ')).toBe('bob-sons');
  });

  it('returns null when nothing usable survives normalization', () => {
    expect(normalizeThemeId('!!!')).toBeNull();
    expect(normalizeThemeId('')).toBeNull();
  });

  it('reserves the ids upstream ships or plans to ship', () => {
    // Frozen before the scaffolder can generate stores: if a merchant could
    // claim `studio`, the upstream Studio example would have nowhere to land.
    expect(RESERVED_THEME_IDS).toEqual(expect.arrayContaining(['default', 'studio', 'market']));
  });

  it('refuses to resolve a traversing id to a path', () => {
    expect(() => themePath('../features', fixture(['default']))).toThrow(/not a valid theme id/);
  });
});

describe('discovery', () => {
  it('finds every theme in the tree, selected or not', () => {
    expect(discoverThemeIds(fixture(['default', 'studio', 'acme']))).toEqual([
      'acme',
      'default',
      'studio',
    ]);
  });

  it('fails on a directory that is not a valid id, naming it', () => {
    // A misnamed directory is an attempted theme. Skipping it would silently
    // drop it from the boundary checker, the generated artifacts, and the CI
    // matrix — every guard green on a theme none of them saw.
    const root = fixture(['default']);
    mkdirSync(join(root, 'src/themes', 'My-Theme'), { recursive: true });

    expect(() => discoverThemeIds(root)).toThrow(/My-Theme/);
    expect(() => discoverThemeIds(root)).toThrow(/lowercase/);
  });

  it('still ignores hidden directories and plain files', () => {
    // OS and editor droppings are not attempts at a theme.
    const root = fixture(['default']);
    mkdirSync(join(root, 'src/themes', '.backup'), { recursive: true });
    writeFileSync(join(root, 'src/themes', '.DS_Store'), '');
    writeFileSync(join(root, 'src/themes', 'notes.txt'), '');

    expect(discoverThemeIds(root)).toEqual(['default']);
  });
});

describe('resolveTheme', () => {
  it('reads the committed configuration', () => {
    const root = fixture(['default'], '{"theme":"default"}');

    expect(resolveTheme(root).id).toBe('default');
  });

  it('lets an explicit environment override win', () => {
    process.env.THEME = 'acme';
    const root = fixture(['default', 'acme'], '{"theme":"default"}');

    const resolved = resolveTheme(root);
    expect(resolved.id).toBe('acme');
    expect(resolved.source).toMatch(/environment/);
  });

  it('fails closed when the configuration file is missing', () => {
    // The dangerous case. A store that loses this file must NOT silently build
    // and deploy the upstream design in place of its own.
    const root = fixture(['default', 'acme']);

    expect(() => resolveTheme(root)).toThrow(/Missing theme\.config\.json/);
  });

  it.each([
    ['{', /not valid JSON/],
    ['{}', /no "theme" string/],
    ['{"theme":""}', /no "theme" string/],
    ['{"theme":"Acme"}', /not a valid theme id/],
  ])('fails on malformed configuration %s', (body, expected) => {
    expect(() => resolveTheme(fixture(['default'], body))).toThrow(expected);
  });

  it('fails when the named theme does not exist', () => {
    expect(() => resolveTheme(fixture(['default'], '{"theme":"studio"}'))).toThrow(
      /does not exist/,
    );
  });

  it('lists the available sets when it fails', () => {
    // A typo should say what the choices are, not resolve to nothing.
    expect(() => resolveTheme(fixture(['default', 'acme'], '{"theme":"deafult"}'))).toThrow(
      /Available themes: acme, default/,
    );
  });
});
