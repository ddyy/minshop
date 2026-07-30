import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  RESERVED_SET_IDS,
  discoverSetIds,
  isValidSetId,
  normalizeSetId,
  resolveStorefrontSet,
  setPath,
} from '../../scripts/storefront-set.mjs';

// .mjs: reads the filesystem, and tsconfig.compilerOptions.types is pinned to
// the Cloudflare types. Same reason as boundary.test.mjs.

const roots = [];
function fixture(sets, config) {
  const root = mkdtempSync(join(tmpdir(), 'storefront-set-'));
  roots.push(root);
  for (const id of sets) mkdirSync(join(root, 'src/storefront', id), { recursive: true });
  if (config !== undefined) writeFileSync(join(root, 'storefront.config.json'), config);
  return root;
}

afterEach(() => {
  delete process.env.STOREFRONT;
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

describe('set ids', () => {
  it.each(['default', 'studio', 'acme', 'acme-holiday', 'shop2'])('accepts %s', (id) => {
    expect(isValidSetId(id)).toBe(true);
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
    expect(isValidSetId(id)).toBe(false);
  });

  it('normalizes a free-form store name into an id', () => {
    expect(normalizeSetId('Acme Supply Co.')).toBe('acme-supply-co');
    expect(normalizeSetId('  Bob & Sons  ')).toBe('bob-sons');
  });

  it('returns null when nothing usable survives normalization', () => {
    expect(normalizeSetId('!!!')).toBeNull();
    expect(normalizeSetId('')).toBeNull();
  });

  it('reserves the ids upstream ships or plans to ship', () => {
    // Frozen before the scaffolder can generate stores: if a merchant could
    // claim `studio`, the upstream Studio example would have nowhere to land.
    expect(RESERVED_SET_IDS).toEqual(expect.arrayContaining(['default', 'studio', 'market']));
  });

  it('refuses to resolve a traversing id to a path', () => {
    expect(() => setPath('../features', fixture(['default']))).toThrow(/not a valid storefront set id/);
  });
});

describe('discovery', () => {
  it('finds every set in the tree, selected or not', () => {
    expect(discoverSetIds(fixture(['default', 'studio', 'acme']))).toEqual([
      'acme',
      'default',
      'studio',
    ]);
  });

  it('ignores directories that are not valid ids', () => {
    const root = fixture(['default']);
    mkdirSync(join(root, 'src/storefront', 'Not An Id'), { recursive: true });

    expect(discoverSetIds(root)).toEqual(['default']);
  });
});

describe('resolveStorefrontSet', () => {
  it('reads the committed configuration', () => {
    const root = fixture(['default'], '{"set":"default"}');

    expect(resolveStorefrontSet(root).id).toBe('default');
  });

  it('lets an explicit environment override win', () => {
    process.env.STOREFRONT = 'acme';
    const root = fixture(['default', 'acme'], '{"set":"default"}');

    const resolved = resolveStorefrontSet(root);
    expect(resolved.id).toBe('acme');
    expect(resolved.source).toMatch(/environment/);
  });

  it('fails closed when the configuration file is missing', () => {
    // The dangerous case. A store that loses this file must NOT silently build
    // and deploy the upstream design in place of its own.
    const root = fixture(['default', 'acme']);

    expect(() => resolveStorefrontSet(root)).toThrow(/Missing storefront\.config\.json/);
  });

  it.each([
    ['{', /not valid JSON/],
    ['{}', /no "set" string/],
    ['{"set":""}', /no "set" string/],
    ['{"set":"Acme"}', /not a valid set id/],
  ])('fails on malformed configuration %s', (body, expected) => {
    expect(() => resolveStorefrontSet(fixture(['default'], body))).toThrow(expected);
  });

  it('fails when the named set does not exist', () => {
    expect(() => resolveStorefrontSet(fixture(['default'], '{"set":"studio"}'))).toThrow(
      /does not exist/,
    );
  });

  it('lists the available sets when it fails', () => {
    // A typo should say what the choices are, not resolve to nothing.
    expect(() => resolveStorefrontSet(fixture(['default', 'acme'], '{"set":"deafult"}'))).toThrow(
      /Available sets: acme, default/,
    );
  });
});
