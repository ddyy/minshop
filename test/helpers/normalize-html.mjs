/**
 * Normalization for storefront HTML baselines.
 *
 * The equivalence gate compares structural markup: tags, attributes, classes,
 * form fields, metadata. It must therefore normalize ONLY values that vary
 * between two runs of the same code — never anything a refactor could change by
 * accident. Every rule below exists because the value is generated per build or
 * per fixture load, not because the output was inconvenient to diff.
 */

/** Public IDs are minted by the fixture loader with randomblob(), so they differ
 *  on every harness run. The prefix is preserved: dropping it would hide a
 *  public-ID leak regression, which is exactly what this gate should catch. */
const PUBLIC_ID = /\b(prod|cat|ord|var|xtra|pimg|med|page)_[0-9abcdefghjkmnpqrstvwxyz]{10}\b/g;

/** Vite content hashes change whenever bundle bytes change, including for edits
 *  that leave the markup identical. */
const ASSET_HASH = /\/_astro\/([A-Za-z0-9_.-]+?)\.[A-Za-z0-9_-]{8}\.(css|js)/g;

/** Astro's scoped-style class, derived from the component's file path — it moves
 *  when a component moves, which extraction does deliberately. Presence is kept
 *  (a lost scoped style is a real regression); the hash itself is not. */
const ASTRO_CID = /data-astro-cid-[a-z0-9]+/g;

export function normalizeHtml(html) {
  return (
    html
      .replace(PUBLIC_ID, (_match, prefix) => `${prefix}_<id>`)
      .replace(ASSET_HASH, '/_astro/$1.<hash>.$2')
      .replace(ASTRO_CID, 'data-astro-cid-<hash>')
      // One tag per line. The build minifies the document onto a single line,
      // which would report every difference as "line 7 changed" against 40KB of
      // context. Applied to baseline and current alike, so it only affects how a
      // failure reads, never whether one is detected.
      .replace(/></g, '>\n<')
      // Trailing whitespace only: internal indentation is structural evidence.
      .split('\n')
      .map((line) => line.replace(/\s+$/, ''))
      .join('\n')
      .trim() + '\n'
  );
}

/** Response headers worth pinning. Cache-control and cache tags are part of the
 *  contract an extraction must not move or drop. */
const PINNED_HEADERS = [
  'content-type',
  'cache-control',
  'cache-tag',
  'vary',
  // A redirect's target is route behavior an extraction must preserve, and
  // several shell consumers legitimately baseline as a redirect.
  'location',
];

export function normalizeHeaders(headers) {
  return PINNED_HEADERS.flatMap((name) => {
    const value = headers.get(name);
    if (value == null) return [];
    return [`${name}: ${value.replace(PUBLIC_ID, (_m, prefix) => `${prefix}_<id>`)}`];
  }).join('\n');
}
