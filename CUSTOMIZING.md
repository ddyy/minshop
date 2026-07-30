# Customizing your storefront

These files belong to your store. Upstream will not rewrite them, and you can
change them without reading the payment, database, or caching code.

Everything here is compiled with the app at deploy time. There is no runtime
theme engine and no code editor in Admin — you edit source, build, and deploy.

## What you own

| File | What it controls |
| --- | --- |
| `src/themes/<your-theme>/` | Your theme — templates and tokens. Created for you at setup. |
| `src/styles/overrides.css` | Optional overrides applied after your theme's tokens. |
| `src/themes/<your-theme>/Header.astro` | Logo, announcement bar, navigation, search, cart and account placement. |
| `src/themes/<your-theme>/Footer.astro` | Footer navigation and store attribution. |
| `src/themes/<your-theme>/ProductCard.astro` | Every product card — catalog, category, search, and the "You may also like" row. |
| `src/themes/<your-theme>/Catalog.astro` | The catalog page at both `/` and `/products`: headings, category links, grid, empty state. |
| `src/themes/<your-theme>/ProductDetail.astro` | The product page: gallery, details, purchase panel, and recommendations. |
| `src/themes/<your-theme>/ContentPage.astro` | The frame around a merchant's Markdown page. |
| `src/themes/<your-theme>/tokens.css` | Your theme's design tokens: the `@theme` block (colors, fonts, radii) plus the prose and container scales. |

That is the whole store-owned surface.

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

## The catalog contract

`Catalog.astro` receives a `CatalogPageModel`: eyebrow, heading, category links,
product cards, and finished `sort` and `pagination` models. It runs no queries
and reads no query parameters — the loader has already parsed, bounded, and
validated everything, and tagged the response for cache invalidation.

Two controls to keep:

| Control | What it owns |
| --- | --- |
| `<CatalogSort>` | Sort links whose hrefs encode the direction flip and deliberately drop `page`. |
| `<CatalogPagination>` | The pagination landmark, `aria-current="page"`, and `rel=prev`/`rel=next`. |

Those URLs are not cosmetic: they decide which pages exist, which one is
canonical, and how many cache entries the catalog occupies. Restyle the controls
with `class`; don't rebuild their links.

The same `Catalog.astro` renders `/` and `/products`, so one edit changes both —
which is why sort and page links are built from the current path rather than a
hardcoded one.

## The product page contract

`ProductDetail.astro` receives two models. `model` is presentation — name,
formatted price, categories, gallery images, related cards, availability.
`purchase` is everything the buy controls need, with the decisions already made:
`soldOut` accounts for variant-level inventory, and `showAddToCart`/`showBuyNow`
already fold in the store's cart and buy-now toggles and whether any payment
rail can actually take money.

The route keeps the 404, the page metadata, and the JSON-LD. Those are not
presentation, and getting them subtly wrong is invisible on the page.

| Control | What it owns |
| --- | --- |
| `<ProductGallery>` | Frame anchors the variant selector scrolls to, and LCP treatment on the first frame only. |
| `<ProductPurchaseForm>` | Form actions and methods, `product_id`/`variant_id`/`extra` field names, sold-out and required states, and `data-fullpage`. |

`data-fullpage` deserves a specific warning. The shell's cart script intercepts
submits to open the drawer; that attribute is what tells it to stand back so
Buy now performs a real navigation to `/express`. Rebuild the form without it
and nothing errors — Buy now just quietly stops working.

Both controls take a `class`. `<ProductGallery>` also takes `soldOutLabel` if
you want different wording.

## The content page contract

`ContentPage.astro` receives a title and `html` that is **already rendered from
Markdown and sanitized**. Embed it; do not parse, escape, or transform it. The
trusted-HTML boundary is upstream, and re-handling it here either double-escapes
a merchant's page or moves the XSS surface into an editable file.

Two things are contract rather than design:

- **`class="markdown-content"`** is what the prose styles are scoped to. Remove
  it and every heading, list, and link in every merchant page loses its
  typography at once, with nothing in the markup to explain why.
- **`style={model.layoutStyle}`** carries the width and title alignment the
  merchant picked in Admin. Drop it and every page reverts to the default.

The prose scale itself is yours, in your theme's `tokens.css` (outside the `@theme` block):

```css
:root {
  --prose-measure: 48rem;
  --prose-leading: 1.75;
  --prose-h1-size: 2.25rem;
  --prose-h1-tracking: -0.02em;
  --prose-h2-size: 1.5rem;
  --prose-h2-tracking: -0.01em;
  --prose-h3-size: 1.125rem;
}
```

These are plain custom properties, deliberately outside the `@theme` block:
core CSS reads them directly and they generate no utilities. Every rule that
reads one keeps the current value as its fallback, so replacing this file with a
design system's tokens and omitting one degrades to today's design rather than
to an unstyled heading.

A merchant's per-page layout preset still wins over `--prose-measure`. That is
intentional: their explicit choice of a wide or centred page outranks a theme
default.

## Page container

The width and padding of the page are yours, via tokens the layout reads:

```css
:root {
  --page-max:   72rem;    /* content column width */
  --page-pad-x: 1.5rem;   /* horizontal padding */
  --page-pad-y: 3rem;     /* vertical padding */
}
```

Declare them in your theme's `tokens.css`. Omit any and it falls back to the value
above, so a theme that says nothing renders like the default. A dense design can
widen and tighten; an editorial one can narrow.

To run an element full-bleed to the container edge, use a negative margin equal
to your own `--page-pad-x`.

## Markers to keep

A few attributes are contract rather than styling. Reword and restyle what is
inside them; keep the marker. Each exists because the state it names would
otherwise be indistinguishable to an automated check — or to a screen reader.

| Marker | Where | Why |
| --- | --- | --- |
| `role="status"` | Catalog empty state | An empty catalog must announce itself, not render a blank grid. |
| `data-low-stock` | Product page scarcity note | Keeps scarcity distinguishable from normal availability without publishing a count. |
| `class="markdown-content"` | Content page | The hook every prose style is scoped to. |

## Two conventions the contract tests enforce

**Navigation landmarks carry a non-empty accessible name.** The name itself is
yours — "Primary", "Shop", "Main" all pass. An unlabelled `<nav>` does not.

**`<StoreNav>` renders merchant links twice**, once in the inline row and once
in the mobile disclosure, so navigation is reachable at every width with
scripts blocked. That duplication is deliberate and asserted; if a design
genuinely needs a single responsive navigation, that is a change to the control
upstream, not a test to relax in your theme.

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

Tokens live in your theme's `tokens.css` (`src/themes/<your-theme>/tokens.css`),
in a Tailwind v4 `@theme` block, and become utilities automatically —
`--color-brand` gives you `bg-brand`, `text-brand`, and so on. Structure is
expressed with Tailwind utilities in your own markup.

`src/styles/overrides.css` is a different, later layer: ordinary custom-property
overrides applied AFTER your theme's tokens. Its normal state is empty. Use it
for values you want to survive switching themes, or when adopting a design
system's variables wholesale; everything that defines your theme's look belongs
in the theme's own `tokens.css`.

Two token families behave differently when omitted, and the difference
matters:

- The **page and prose properties** (`--page-*`, `--prose-*`) are read by core
  CSS through `var()` with literal fallbacks. Omit one and that rule renders
  exactly as the default does.
- The **semantic `@theme` tokens** (`--color-*`, `--font-*`, `--radius-*`)
  have NO fallback: they are what generates the utilities. A theme that omits
  `--color-brand` doesn't get the default brand — `bg-brand` simply stops
  being generated. Every theme must therefore declare the complete semantic
  surface; the contract suite enforces the required names for every theme in
  the tree.

Only your active theme's directory is scanned for utilities (inactive themes are
excluded per build, and generated files under `src/styles/storefront/` wire
that up — never edit or commit them). Classes you add in your theme are
generated without touching any config file.

Admin is deliberately NOT part of any of this: it compiles its own stylesheet
(`src/styles/admin.css`) with a frozen palette, so authenticated Admin pages
look the same in every store, under any theme, including dark ones.

Upstream controls keep the functional styling they need — state, accessibility,
and layout classes stay inside them. Each accepts a root `class` you can merge.
`StoreNav` takes two, `class` and `disclosureClass`, because it renders an
inline row and a mobile disclosure at different breakpoints and one prop could
only reach one of them. Restyling every internal part of a control is not
supported in this release.

## After you change something

```bash
npm run theme:check && npm run test:storefront-contract
```

The first enforces the import and request-context boundary, following each file
through its local dependencies — a control that imports a helper that imports a
binding is caught, not just a direct import.

The second renders your components from their models and asserts what has to
hold for any design: public IDs rather than row IDs, no stock counts, resolved
image URLs, LCP priority on the first card only, form and landmark semantics,
and the behavior hooks the cart drawer depends on. It ignores classes, wrappers,
copy, and layout, so a redesign should pass it unchanged.

It does not start a Worker, so it says nothing about response headers. Cache
control and cache tags are checked by the integration suite in `npm run verify`,
against a real built Worker.

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

## Your theme, and upstream's

`src/themes/default/` belongs to upstream and receives improvements. Your
theme is a copy of it, created and selected when your store was scaffolded, and
upstream never writes there.

That separation is the point: edit your own theme and an upstream change to the
default can never collide with your work. Editing `default/` directly gives that
guarantee up.

The same rule covers the other shipped designs, `studio/` and `market/`, and
their ids are reserved along with `default` so upstream always has somewhere to
put them.

## Starting from Studio or Market

The shipped designs are reference implementations, and they are also legitimate
starting points. Copy one's CONTENTS into your own theme rather than selecting it
directly — a store that selects `studio` is editing an upstream directory again,
with all the collision it was scaffolded to avoid:

```bash
rm -rf src/themes/your-store
cp -R src/themes/studio src/themes/your-store
```

Leave `theme.config.json` naming `your-store`. Then run the gates:

```bash
npm run theme:check
npm run test:storefront-contract
npm run verify
```

Provenance: `default`, `studio`, and `market` are original designs written for
this repository. They embed no third-party assets — every font stack resolves
to system faces, and Studio's grain texture is an inline SVG authored here — so
copying one into your theme carries no license or attribution obligation.

Which theme is active is one value:

```json
{ "theme": "your-store" }
```

in `theme.config.json`. Change it and rebuild to try another theme;
`THEME=<id> npm run dev` does the same thing for one command.

## Resetting a file

Your templates are ordinary tracked files, so git is the undo:

```bash
git checkout HEAD -- src/themes/acme/ProductCard.astro
```

(Replace `acme` with your theme id.) Work on a branch when making large changes,
so the default is always one command away.

## Caching

Template changes take effect on deploy — the deploy purges the previous
version's HTML. Admin-managed content (products, logo, navigation) purges on its
own schedule and needs no template change.
