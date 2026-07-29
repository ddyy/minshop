# Customizing your storefront

These files belong to your store. Upstream will not rewrite them, and you can
change them without reading the payment, database, or caching code.

Everything here is compiled with the app at deploy time. There is no runtime
theme engine and no code editor in Admin — you edit source, build, and deploy.

## What you own

| File | What it controls |
| --- | --- |
| `src/styles/theme.css` | Brand tokens: colors, fonts, radii. |
| `src/storefront/Header.astro` | Logo, announcement bar, navigation, search, cart and account placement. |
| `src/storefront/Footer.astro` | Footer navigation and store attribution. |
| `src/storefront/ProductCard.astro` | Every product card — catalog, category, search, and the "You may also like" row. |

More surfaces (catalog, product page, content pages) land in later releases and
will appear in this table as they do.

### The header renders on every page

That includes cart, checkout, payment, account, and Admin login — not just
browse pages. A header that breaks is a checkout that breaks, so keep the core
controls listed below and change where they sit rather than what they emit.

## What you don't own

`src/features/storefront/` is upstream: the presentation models your templates
receive, and the controls they compose. `src/layouts/Layout.astro`,
`src/styles/global.css`, and everything under `src/features/` and `src/pages/`
are application code.

The split is not about trust — your templates are ordinary source with full
build-time authority. It is about surface area: a visual change should not
require you to understand cache tags, SEO invariants, or inventory rules, and it
should be impossible to break them by accident.

## The product card contract

Your card receives a `ProductCardModel`:

```ts
interface ProductCardModel {
  id: string;              // prod_ public ID — never a database row ID
  name: string;
  href: string;            // root-relative product URL
  image: StorefrontImage;  // already resolved: src, srcset, sizes, alt, priority
  formattedPrice: string;  // already formatted in the store's currency
  inStock: boolean;        // availability only — never a quantity
}
```

Every value arrives finished. Do not recompute prices, build image URLs from
keys, or derive availability from a stock number — those are decided upstream,
where the store's settings are known.

A minimal card:

```astro
---
import type { ProductCardModel } from '../features/storefront/models';
import StoreImage from '../features/storefront/controls/StoreImage.astro';

interface Props {
  card: ProductCardModel;
  index?: number;
  headingLevel?: 'h2' | 'h3';
}

const { card, headingLevel = 'h2' } = Astro.props;
const Heading = headingLevel;
---

<li>
  <a href={card.href}>
    <StoreImage image={card.image} class="w-full" />
    <Heading>{card.name}</Heading>
    <p>{card.formattedPrice}</p>
    {!card.inStock && <span>Sold out</span>}
  </a>
</li>
```

### Controls you must keep

Render images through `<StoreImage>`. It owns the responsive attributes, the
aspect hint that prevents layout shift, and the LCP behavior for the first card
on a page. Copying its markup to adjust spacing loses all three — wrap it or
pass `class` instead.

## The shell contract

`Header.astro` and `Footer.astro` receive a `StorefrontShellModel`: store name,
resolved logo, announcement, header and footer links, and `enabled`/`href` pairs
for search, cart, account, and blog. Merchant links are pre-filtered to targets
that are actually publishable, so you cannot render a dead link.

Four controls carry behavior your template must not reimplement:

| Control | What it owns |
| --- | --- |
| `<StoreNav>` | Inline links plus the mobile `<details>` disclosure, which works with no JavaScript. |
| `<StoreSearch>` | GET method, the `q` field, the search landmark, the accessible label. |
| `<StoreCartControl>` | The `data-cart-open` and `data-cart-count-label` hooks the drawer script depends on. |
| `<StoreAccountControl>` | The account destination, which middleware guards. |

Each takes a `class` for placement and styling. Reimplementing one is the one
change most likely to break something silently: the cart drawer script fails
soft, so a header missing its hooks looks fine and simply stops opening.

The cart drawer itself lives in `Layout.astro`, next to the script that drives
it. Leave it there — nesting a fixed dialog inside the sticky, backdrop-filtered
header changes its positioning context.

## Rules

1. **Public IDs only.** Never render a numeric row ID.
2. **Money is server-authoritative.** `formattedPrice` is for display; a price
   posted back from a template is not trusted.
3. **No database or storage access.** Templates receive models, not queries.
4. **No request context.** `Astro.locals`, `Astro.request`, `Astro.url`, and
   `Astro.response` are unavailable by policy. If you need a value, it belongs
   in the model — open an issue rather than reaching around it.
5. **Availability is a boolean.** Exact stock counts stay private.

## Styling

Tokens live in `src/styles/theme.css` and become Tailwind utilities
automatically — `--color-brand` gives you `bg-brand`, `text-brand`, and so on.
Structure is expressed with Tailwind utilities in your own markup.

Tailwind v4 detects utility usage in `src/storefront/` with no configuration, so
classes you add there are generated without touching any config file.

Upstream controls keep the functional styling they need — state, accessibility,
and layout classes stay inside them. They accept a root `class` you can merge.
Restyling every internal part of a control is not supported in this release.

## After you change something

```bash
npm run storefront:check && npm run test:storefront-contract
```

The first enforces the import and request-context boundary. The second is the
one that matters: it asserts your storefront still honors the application
contract — public IDs, image priority, availability, cache headers — while
ignoring classes, wrappers, and layout. A redesign should pass it unchanged.

Then look at the result:

```bash
npm run dev
```

Check `/`, `/products`, a category, a search result, and a product page, at
mobile and desktop widths. Try a long product name, a sold-out item, and an
empty search — those are where card layouts break.

`npm run test:storefront-equivalence` is a different tool: it asserts your HTML
matches the *default* design byte-for-byte. It exists for upstream extraction
work. If you have customized anything, it is supposed to fail, and it is not
part of `npm run verify`.

## Resetting a file

Your templates are ordinary tracked files, so git is the undo:

```bash
git checkout HEAD -- src/storefront/ProductCard.astro
```

Work on a branch when making large changes, so the default is always one command
away.

## Caching

Template changes take effect on deploy — the deploy purges the previous
version's HTML. Admin-managed content (products, logo, navigation) purges on its
own schedule and needs no template change.
