import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// Deliberately .mjs: reading source files needs node types, and
// tsconfig.compilerOptions.types is pinned to the Cloudflare types. Same reason
// as boundary.test.mjs — see its note.
//
// These are source-level assertions because Layout.astro cannot be rendered
// through AstroContainer: it reads request context and runtime bindings. They
// still catch the realistic regression, which is someone relocating or deleting
// the drawer, or renaming one side of a two-sided hook contract.
describe('the document shell', () => {
  // The drawer lives in Layout.astro beside its enhancement script, not in the
  // store-owned header — nesting a fixed dialog under the sticky, backdrop-
  // filtered header would change its containing block. Layout needs request
  // context, so this is a source-level assertion: it catches the realistic
  // regression, which is someone relocating or deleting the drawer.
  const layout = readFileSync('src/layouts/Layout.astro', 'utf8');

  it.each([
    'data-cart-drawer',
    'data-cart-panel',
    'data-cart-backdrop',
    'data-cart-body',
    'data-cart-close',
  ])('keeps %s in the document shell', (hook) => {
    expect(layout).toContain(hook);
  });

  it('reads the count the cart partial writes', () => {
    // Two sides of one contract: the partial emits data-cart-count, the shell
    // script queries it. A one-sided rename passes both files in isolation.
    const partial = readFileSync('src/pages/partials/cart.astro', 'utf8');

    expect(partial).toContain('data-cart-count');
    expect(layout).toContain('[data-cart-count]');
  });
});
