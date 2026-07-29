import { describe, expect, it } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import Header from '../../src/storefront/Header.astro';
import Footer from '../../src/storefront/Footer.astro';
import AltHeader from './fixtures/shell/AltHeader.astro';
import { buildShellModel, type ShellInput } from '../../src/features/storefront/shell';
import type { MenuItem } from '../../src/features/navigation/db';

const menuItem = (text: string, href: string): MenuItem =>
  ({ text, href, available: true }) as MenuItem;

const input = (overrides: Partial<ShellInput> = {}): ShellInput => ({
  storeName: 'My Shop',
  logoImageKey: null,
  imageBaseUrl: '',
  announcement: '',
  announcementHref: '',
  headerItems: [],
  footerItems: [],
  searchQuery: '',
  cartEnabled: true,
  accountsEnabled: false,
  blogEnabled: false,
  ...overrides,
});

const render = async (component: unknown, model: unknown) => {
  const container = await AstroContainer.create();
  // No request, no locals: the shell renders on checkout and the pay page, so
  // it must never depend on anything the model does not carry.
  return container.renderToString(component as never, { props: { model } });
};

describe('buildShellModel', () => {
  it('falls back to the store name when there is no logo', () => {
    expect(buildShellModel(input()).logo).toBeNull();
  });

  it('resolves a logo key into a URL, never leaving the key exposed', () => {
    const { logo } = buildShellModel(
      input({ logoImageKey: 'media/logo.png', imageBaseUrl: 'https://img.example.com' }),
    );

    expect(logo?.src).toBe('https://img.example.com/media/logo.png');
    expect(logo?.alt).toBe('My Shop');
    // Above the fold on every route, so never lazy.
    expect(logo?.priority).toBe(true);
  });

  it('treats an empty announcement as absent, not as empty markup', () => {
    expect(buildShellModel(input()).announcement).toBeNull();
    expect(buildShellModel(input({ announcement: 'Free shipping' })).announcement).toEqual({
      text: 'Free shipping',
      href: null,
    });
  });

  it('normalizes an empty announcement link to null', () => {
    const model = buildShellModel(input({ announcement: 'Sale', announcementHref: '' }));

    expect(model.announcement?.href).toBeNull();
  });
});

describe('the store-owned header', () => {
  it('renders the store name when no logo is set', async () => {
    const html = await render(Header, buildShellModel(input()));

    expect(html).toContain('My Shop');
    expect(html).not.toContain('<img');
  });

  it('renders a logo image when one is set', async () => {
    const html = await render(
      Header,
      buildShellModel(input({ logoImageKey: 'media/logo.png' })),
    );

    expect(html).toContain('src="/images/media/logo.png"');
    expect(html).toContain('alt="My Shop"');
  });

  it('keeps the cart hooks the drawer script depends on', async () => {
    const html = await render(Header, buildShellModel(input({ cartEnabled: true })));

    // The script fails soft when these disappear, so losing them breaks the
    // drawer silently. That is why they are asserted rather than eyeballed.
    expect(html).toContain('data-cart-open');
    expect(html).toContain('data-cart-count-label');
  });

  it('drops the cart entirely when the store is browse-only', async () => {
    const html = await render(Header, buildShellModel(input({ cartEnabled: false })));

    expect(html).not.toContain('data-cart-open');
    expect(html).not.toContain('data-cart-count-label');
  });

  it('shows the mobile disclosure only when there is navigation to disclose', async () => {
    const without = await render(Header, buildShellModel(input()));
    const withLinks = await render(
      Header,
      buildShellModel(input({ headerItems: [menuItem('About', '/pages/about')] })),
    );

    expect(without).not.toContain('data-nav-disclosure');
    expect(withLinks).toContain('data-nav-disclosure');
    expect(withLinks).toContain('<details');
    expect(withLinks).toContain('aria-label="Menu"');
  });

  it('keeps navigation usable without JavaScript', async () => {
    const html = await render(
      Header,
      buildShellModel(input({ headerItems: [menuItem('About', '/pages/about')] })),
    );

    // A native <details>/<summary> carries the disclosure role and expanded
    // state on its own. A checkbox or a script-driven menu would not.
    expect(html).toContain('<summary');
    expect(html).not.toContain('type="checkbox"');
    // Both the inline row and the disclosure list the link, so it is reachable
    // at every width even with scripts blocked.
    expect(html.match(/href="\/pages\/about"/g)?.length).toBe(2);
  });

  it('keeps the search form a real GET form with the q field', async () => {
    const html = await render(Header, buildShellModel(input({ searchQuery: 'tee' })));

    expect(html).toContain('method="GET"');
    expect(html).toContain('action="/search"');
    expect(html).toContain('name="q"');
    expect(html).toContain('value="tee"');
    expect(html).toContain('role="search"');
    expect(html).toContain('aria-label="Search products"');
  });

  it('renders the announcement link only when one is set', async () => {
    const plain = await render(Header, buildShellModel(input({ announcement: 'Sale' })));
    const linked = await render(
      Header,
      buildShellModel(input({ announcement: 'Sale', announcementHref: '/products' })),
    );

    expect(plain).toContain('Sale');
    expect(linked).toContain('href="/products"');
  });

  it('labels its landmarks', async () => {
    const html = await render(Header, buildShellModel(input()));

    expect(html).toContain('aria-label="Primary"');
  });
});

describe('the store-owned footer', () => {
  it('shows the store name and merchant links', async () => {
    const html = await render(
      Footer,
      buildShellModel(input({ footerItems: [menuItem('Privacy', '/pages/privacy')] })),
    );

    expect(html).toContain('My Shop');
    expect(html).toContain('href="/pages/privacy"');
    expect(html).toContain('aria-label="Footer"');
  });

  it('omits the footer nav entirely when there are no links', async () => {
    const html = await render(Footer, buildShellModel(input()));

    expect(html).not.toContain('aria-label="Footer"');
  });
});

describe('an independently authored shell', () => {
  it('satisfies the same model with different structure', async () => {
    const model = buildShellModel(
      input({
        announcement: 'Free shipping',
        headerItems: [menuItem('About', '/pages/about')],
        accountsEnabled: true,
        blogEnabled: true,
      }),
    );
    const html = await render(AltHeader, model);

    expect(html).toContain('alt-shell');
    expect(html).toContain('Free shipping');
    expect(html).toContain('Journal');
    // Behavior-bearing hooks survive a completely different composition,
    // because they live in the controls rather than in the template.
    expect(html).toContain('data-cart-open');
    expect(html).toContain('data-nav-disclosure');
  });
});
