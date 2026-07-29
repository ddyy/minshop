import { describe, expect, it } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import ContentPage from '../../src/storefront/ContentPage.astro';
import AltContentPage from './fixtures/content-page/AltContentPage.astro';
import type { ContentPageModel } from '../../src/features/storefront/models';

const model = (overrides: Partial<ContentPageModel> = {}): ContentPageModel => ({
  title: 'About',
  html: '<h2>Our story</h2>\n<p>A <a href="/products">link</a>.</p>',
  layout: 'standard',
  layoutStyle: '--page-measure:48rem;--page-title-align:left',
  ...overrides,
});

const render = async (component: unknown, value: ContentPageModel) => {
  const container = await AstroContainer.create();
  return container.renderToString(component as never, { props: { model: value } });
};

describe('the store-owned content page', () => {
  it('embeds the rendered body verbatim', async () => {
    // The template must not parse, escape, or transform it — the markup was
    // rendered and sanitized upstream, and doing either here would either
    // double-escape a merchant's page or move the trusted-HTML boundary.
    const html = await render(ContentPage, model());

    expect(html).toContain('<h2>Our story</h2>');
    expect(html).toContain('<a href="/products">link</a>');
  });

  it('keeps the hook the prose styles are scoped to', async () => {
    // Losing this class strips typography from every merchant page at once,
    // with nothing in the markup to suggest why.
    const html = await render(ContentPage, model());

    expect(html).toContain('markdown-content');
  });

  it("carries the merchant's layout preset", async () => {
    const html = await render(ContentPage, model({ layout: 'wide', layoutStyle: '--page-measure:72rem;--page-title-align:center' }));

    expect(html).toContain('data-page-layout="wide"');
    expect(html).toContain('--page-measure:72rem');
    expect(html).toContain('--page-title-align:center');
  });

  it('renders the title as the page heading', async () => {
    const html = await render(ContentPage, model({ title: 'Privacy Policy' }));

    expect(html).toContain('<h1>Privacy Policy</h1>');
  });
});

describe('an independently authored content wrapper', () => {
  it('restructures freely while keeping both contract pieces', async () => {
    const html = await render(AltContentPage, model({ layout: 'centered' }));

    expect(html).toContain('alt-page__eyebrow');
    expect(html).toContain('markdown-content');
    expect(html).toContain('data-page-layout="centered"');
    expect(html).toContain('<h2>Our story</h2>');
  });
});
