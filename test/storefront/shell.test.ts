import { describe, expect, it } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import Header from '#storefront/Header.astro';
import Footer from '#storefront/Footer.astro';
import AltHeader from './fixtures/shell/AltHeader.astro';
import StoreNav from '../../src/features/storefront/controls/StoreNav.astro';
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

/** Navigation landmarks with a non-empty accessible name. The NAME is the
 *  design's to choose — "Primary", "Main", "Shop" are all fine — but an
 *  unlabelled set of landmarks is not, so this asserts the property rather than
 *  the string. */
const labelledNavs = (html: string) =>
  [...html.matchAll(/<nav\b[^>]*aria-label="([^"]+)"/g)].map((m) => m[1].trim()).filter(Boolean);

const navCount = (html: string) => (html.match(/<nav\b/g) ?? []).length;

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

  it('lets a template style both navigation roots', async () => {
    // StoreNav renders an inline row and a disclosure at different breakpoints,
    // so a single class prop could only ever reach one of them.
    const container = await AstroContainer.create();
    const html = await container.renderToString(StoreNav as never, {
      props: {
        links: [{ text: 'About', href: '/pages/about' }],
        class: 'custom-inline',
        disclosureClass: 'custom-disclosure',
      },
    });

    expect(html).toContain('custom-inline');
    expect(html).toContain('custom-disclosure');
    expect(html).toContain('data-nav-disclosure');
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

  it('renders the account destination when accounts are on', async () => {
    // Every other header test runs with accounts off, so without this a store
    // could delete the account link entirely and the suite would stay green.
    const off = await render(Header, buildShellModel(input({ accountsEnabled: false })));
    const on = await render(Header, buildShellModel(input({ accountsEnabled: true })));

    expect(off).not.toContain('href="/account"');
    expect(on).toContain('href="/account"');
  });

  it('renders the blog destination when the feature is built in', async () => {
    const off = await render(Header, buildShellModel(input({ blogEnabled: false })));
    const on = await render(Header, buildShellModel(input({ blogEnabled: true })));

    expect(off).not.toContain('href="/blog"');
    expect(on).toContain('href="/blog"');
  });

  it('keeps every destination reachable with all of them enabled at once', async () => {
    const html = await render(
      Header,
      buildShellModel(
        input({
          accountsEnabled: true,
          blogEnabled: true,
          cartEnabled: true,
          headerItems: [menuItem('About', '/pages/about')],
        }),
      ),
    );

    for (const href of ['/account', '/blog', '/cart', '/pages/about']) {
      expect(html).toContain(`href="${href}"`);
    }
    // Search is REACHABLE, not necessarily a link. The default hides its input
    // below `sm` and adds a link for small screens; a design with an
    // always-visible field satisfies the same contract through the form action
    // alone. Asserting the link would have pinned the default's composition.
    expect(html).toMatch(/(href|action)="\/search"/);
    {
    }
  });

  it('gives every navigation landmark a non-empty accessible name', async () => {
    const html = await render(
      Header,
      buildShellModel(input({ headerItems: [menuItem('About', '/pages/about')] })),
    );

    expect(navCount(html)).toBeGreaterThan(0);
    expect(labelledNavs(html).length).toBe(navCount(html));
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
    // Labelled, but the label itself belongs to the design.
    expect(navCount(html)).toBe(1);
    expect(labelledNavs(html).length).toBe(1);
  });

  it('omits the footer nav entirely when there are no links', async () => {
    const html = await render(Footer, buildShellModel(input()));

    expect(navCount(html)).toBe(0);
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
