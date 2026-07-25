import { describe, it, expect } from 'vitest';
import {
  PAGE_LAYOUTS,
  PAGE_LAYOUT_KEYS,
  PAGE_LAYOUT_OPTIONS,
  DEFAULT_PAGE_LAYOUT,
  normalizePageLayout,
  pageLayoutStyle,
} from './layouts';

describe('normalizePageLayout', () => {
  it('accepts every defined preset', () => {
    for (const key of PAGE_LAYOUT_KEYS) {
      expect(normalizePageLayout(key)).toBe(key);
    }
  });

  it('falls back to the default for an unknown value', () => {
    // A page saved under a preset a developer later REMOVES must still render,
    // so this coerces rather than throwing.
    expect(normalizePageLayout('lookbook')).toBe(DEFAULT_PAGE_LAYOUT);
  });

  it('falls back for null, undefined, and non-strings', () => {
    expect(normalizePageLayout(null)).toBe(DEFAULT_PAGE_LAYOUT);
    expect(normalizePageLayout(undefined)).toBe(DEFAULT_PAGE_LAYOUT);
    expect(normalizePageLayout(7)).toBe(DEFAULT_PAGE_LAYOUT);
    expect(normalizePageLayout({})).toBe(DEFAULT_PAGE_LAYOUT);
  });

  it('does not treat inherited Object keys as presets', () => {
    // `'toString' in PAGE_LAYOUTS` is true via the prototype chain — a naive
    // `in` check would accept it and emit an undefined preset.
    expect(normalizePageLayout('toString')).toBe(DEFAULT_PAGE_LAYOUT);
    expect(normalizePageLayout('constructor')).toBe(DEFAULT_PAGE_LAYOUT);
  });
});

describe('preset definitions', () => {
  it('matches the column default in migration 0027', () => {
    expect(DEFAULT_PAGE_LAYOUT).toBe('standard');
  });

  // These are the invariants that make "add one entry" the whole change: if a
  // preset is missing a field, the generated dropdown or CSS variables break.
  it('every preset is complete and well-formed', () => {
    for (const [key, preset] of Object.entries(PAGE_LAYOUTS)) {
      expect(preset.label, `${key}.label`).toBeTruthy();
      expect(preset.hint, `${key}.hint`).toBeTruthy();
      expect(preset.measure, `${key}.measure`).toMatch(/^\d+(\.\d+)?(rem|px|%|ch)$/);
      expect(['left', 'center'], `${key}.titleAlign`).toContain(preset.titleAlign);
    }
  });

  it('exposes one dropdown option per preset', () => {
    expect(PAGE_LAYOUT_OPTIONS).toHaveLength(PAGE_LAYOUT_KEYS.length);
    expect(PAGE_LAYOUT_OPTIONS.map((o) => o.key)).toEqual(PAGE_LAYOUT_KEYS);
    for (const option of PAGE_LAYOUT_OPTIONS) {
      expect(option.label).toBe(PAGE_LAYOUTS[option.key].label);
    }
  });

  it('has distinct labels so the dropdown is unambiguous', () => {
    const labels = PAGE_LAYOUT_OPTIONS.map((o) => o.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe('pageLayoutStyle', () => {
  it('emits the custom properties global.css consumes', () => {
    expect(pageLayoutStyle('standard')).toBe(
      '--page-measure:48rem;--page-title-align:left',
    );
    expect(pageLayoutStyle('editorial')).toBe(
      '--page-measure:48rem;--page-title-align:center',
    );
    expect(pageLayoutStyle('wide')).toBe('--page-measure:72rem;--page-title-align:left');
  });

  it('produces a style string for every preset, so none needs bespoke CSS', () => {
    for (const key of PAGE_LAYOUT_KEYS) {
      const style = pageLayoutStyle(key);
      expect(style).toContain('--page-measure:');
      expect(style).toContain('--page-title-align:');
      // Inline styles are attribute values; a stray quote would break out.
      expect(style).not.toMatch(/["'<>]/);
    }
  });
});
