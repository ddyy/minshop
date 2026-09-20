import { expect, it } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { getConfig } from '../../../config';
import DemoCheckout from './DemoCheckout.astro';

it('shows the runtime store name and falls back to the configured name', async () => {
  const container = await AstroContainer.create();
  const props = { pending: { amount_total_cents: 1200, currency: 'usd', shipping_cents: 0, items: '[]', email: null } };
  const renamed = await container.renderToString(DemoCheckout, {
    props: { ...props, storeName: 'Renamed Leather Shop' },
  });
  expect(renamed).toContain('Renamed Leather Shop');
  expect(await container.renderToString(DemoCheckout, { props })).toContain(getConfig().storeName);
});
