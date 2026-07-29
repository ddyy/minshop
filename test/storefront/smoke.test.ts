import { describe, expect, it } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import Smoke from './fixtures/smoke/Smoke.astro';

// Guards the harness itself. If this fails, the Vitest/Astro wiring is broken
// (or astro.config.mjs leaked back in) — no storefront contract is implicated.
describe('AstroContainer harness', () => {
  it('renders an .astro component from props alone', async () => {
    const container = await AstroContainer.create();
    const html = await container.renderToString(Smoke, { props: { label: 'ok' } });

    expect(html).toContain('data-smoke');
    expect(html).toContain('ok');
  });

  it('renders without a request or locals', async () => {
    const container = await AstroContainer.create();

    // No `request`/`locals` passed. Every storefront contract test relies on
    // this: a component that needs request context is not props-only, and this
    // is where that shows up.
    await expect(
      container.renderToString(Smoke, { props: { label: 'no-context' } }),
    ).resolves.toContain('no-context');
  });
});
