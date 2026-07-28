import { describe, it, expect } from 'vitest';
import { usageLinks, describeUsage, isUnused, emptyUsage, type MediaUsage } from './usage';

const usage = (partial: Partial<MediaUsage> = {}): MediaUsage => ({
  ...emptyUsage(),
  ...partial,
});

describe('usageLinks', () => {
  it('links a product to its edit screen by public ID', () => {
    expect(
      usageLinks(usage({ products: [{ id: 7, public_id: 'prod_k7m2qx8vn6', name: 'Merino Beanie' }] })),
    ).toEqual([
      {
        href: '/admin/products/prod_k7m2qx8vn6/edit',
        label: 'Merino Beanie',
        kind: 'product',
        title: 'Edit Merino Beanie',
      },
    ]);
  });

  it('links a page to its editor by public ID', () => {
    expect(
      usageLinks(usage({ pages: [{ id: 3, public_id: 'page_b8nr4qx7km', title: 'About' }] })),
    ).toEqual([
      { href: '/admin/pages/page_b8nr4qx7km/edit', label: 'About', kind: 'page', title: 'Edit the About page' },
    ]);
  });

  it('links the logo to settings, where it is chosen', () => {
    // The logo is a setting rather than a row, so there is no per-item URL.
    expect(usageLinks(usage({ logo: true }))).toEqual([
      { href: '/admin/settings', label: 'Store logo', kind: 'logo', title: 'Change the logo in Settings' },
    ]);
  });

  it('lists every use of a file shared across features', () => {
    const links = usageLinks(
      usage({
        products: [
          { id: 1, public_id: 'prod_0000000001', name: 'Tee' },
          { id: 2, public_id: 'prod_0000000002', name: 'Mug' },
        ],
        pages: [{ id: 9, public_id: 'page_0000000009', title: 'Shipping' }],
        logo: true,
      }),
    );
    expect(links.map((l) => l.kind)).toEqual(['product', 'product', 'page', 'logo']);
    expect(links.map((l) => l.href)).toEqual([
      '/admin/products/prod_0000000001/edit',
      '/admin/products/prod_0000000002/edit',
      '/admin/pages/page_0000000009/edit',
      '/admin/settings',
    ]);
  });

  it('returns nothing for unused media, which is what makes it deletable', () => {
    const unused = usage();
    expect(usageLinks(unused)).toEqual([]);
    expect(isUnused(unused)).toBe(true);
  });

  it('agrees with the deletion message about what counts as a use', () => {
    // The grid renders links and the 409 renders prose; they must not disagree
    // about whether a file is in use.
    const inUse = usage({ pages: [{ id: 4, public_id: 'page_0000000004', title: 'Returns' }] });
    expect(usageLinks(inUse)).toHaveLength(1);
    expect(describeUsage(inUse)).toContain('Returns');
    expect(isUnused(inUse)).toBe(false);
  });
});
