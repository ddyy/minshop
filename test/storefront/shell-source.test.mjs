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
/**
 * Remove every <script> block, scanning by index rather than with a regex.
 *
 * The obvious `/<script[\s\S]*?<\/script>/g` is what CodeQL flags as
 * js/bad-tag-filter + js/incomplete-multi-character-sanitization, and the
 * complaint is fair on its own terms: it misses a closing tag written
 * `</script >`, and a single non-looping pass over hostile input can be walked
 * through. Neither can happen here — the input is a checked-in Astro file, not
 * user data — but this is a few lines, is genuinely more correct, and leaves no
 * tag-filtering regex for someone to copy somewhere it WOULD matter.
 */
function withoutScripts(html) {
  let out = '';
  let cursor = 0;
  for (;;) {
    const open = html.indexOf('<script', cursor);
    if (open === -1) return out + html.slice(cursor);
    out += html.slice(cursor, open);
    const close = html.indexOf('</script', open);
    // Unterminated block: drop the remainder rather than emit script source.
    if (close === -1) return out;
    const end = html.indexOf('>', close + '</script'.length);
    if (end === -1) return out;
    cursor = end + 1;
  }
}

describe('the document shell', () => {
  const layout = readFileSync('src/layouts/Layout.astro', 'utf8');

  // Every hook name ALSO appears inside the enhancement script, as the selector
  // it queries. Asserting against the whole file would therefore pass with the
  // drawer markup deleted — the script's own querySelector strings keep each
  // assertion green while the dialog no longer exists. Strip the scripts and
  // assert against markup only.
  const markup = withoutScripts(layout);

  it.each([
    'data-cart-drawer',
    'data-cart-panel',
    'data-cart-backdrop',
    'data-cart-body',
    'data-cart-close',
  ])('keeps %s in the document-shell markup, not only in the script', (hook) => {
    expect(markup).toContain(hook);
  });

  it('keeps the drawer outside the store-owned header', () => {
    // A fixed dialog nested inside the sticky, backdrop-filtered header would
    // take the header as its containing block and mis-position.
    expect(markup.indexOf('data-cart-drawer')).toBeGreaterThan(markup.indexOf('<StoreFooter'));
  });

  it('reads the count the cart partial writes', () => {
    // Two sides of one contract: the partial emits data-cart-count, the shell
    // script queries it. A one-sided rename passes both files in isolation.
    const partial = readFileSync('src/pages/partials/cart.astro', 'utf8');

    expect(partial).toContain('data-cart-count');
    expect(layout).toContain('[data-cart-count]');
  });
});
