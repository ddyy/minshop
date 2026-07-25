import MarkdownIt from 'markdown-it';
import { mediaUrl } from '../media/url.ts';

/**
 * Server-only Markdown renderer, shared by the storefront route and the admin
 * preview endpoint so the two cannot drift. It is never bundled for the browser:
 * the editor's Preview tab posts to /api/admin/pages/preview and renders what
 * this returns.
 *
 * `html: false` is the whole safety model. Raw HTML in a page body is escaped
 * rather than parsed, so an admin cannot inject a <script>, an iframe, or an
 * event handler — and neither can anyone who gets hold of an admin session.
 * markdown-it also validates link targets against its own scheme blocklist
 * (javascript:, vbscript:, file:, and data: except for images), so we do not
 * hand-roll URL filtering.
 */
const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
  typographer: false,
});

/** Root-relative media reference the editor inserts: /images/<key>. */
const LOCAL_IMAGE_PREFIX = '/images/';

function localKeyFromSrc(src: string, baseUrl: string): string | null {
  if (src.startsWith(LOCAL_IMAGE_PREFIX)) {
    return src.slice(LOCAL_IMAGE_PREFIX.length) || null;
  }
  // Absolute form, in case a body was pasted from a store with IMAGE_BASE_URL
  // set. The editor only ever writes the root-relative form.
  if (baseUrl && src.startsWith(`${baseUrl}/`)) {
    return src.slice(baseUrl.length + 1) || null;
  }
  return null;
}

export interface RenderOptions {
  /** config.images.baseUrl — lets page images use a custom image origin. */
  baseUrl?: string;
  /**
   * Emit `data-source-line` on block elements. Admin preview only — it lets a
   * click in the preview jump to the matching line in the editor. The public
   * page renders without it, so storefront HTML stays free of editor plumbing.
   */
  sourceMap?: boolean;
}

/**
 * Rewrite local image sources through mediaUrl() and mark body images as
 * lazy/async. Bodies are stored root-relative and portable; the origin is
 * applied at render time, so changing IMAGE_BASE_URL never requires a rewrite
 * of stored content.
 */
function installImageRule(instance: MarkdownIt, baseUrl: string): void {
  instance.renderer.rules.image = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const src = token.attrGet('src') ?? '';
    const key = localKeyFromSrc(src, baseUrl);
    if (key) token.attrSet('src', mediaUrl(key, baseUrl));
    // markdown-it's DEFAULT image rule fills `alt` from the token's inline
    // children; overriding the rule means doing it here too. Without this every
    // image renders alt="" — the alt text an author typed is silently dropped.
    token.attrSet('alt', self.renderInlineAsText(token.children ?? [], options, env));
    // Body images are below the fold by definition — the header logo is the
    // only image on the page that must not be lazy.
    token.attrSet('loading', 'lazy');
    token.attrSet('decoding', 'async');
    // renderToken escapes attribute values, and alt text goes through the
    // default renderer, so neither can break out into markup.
    return self.renderToken(tokens, idx, options);
  };
}

export function renderMarkdown(markdown: string, options: RenderOptions = {}): string {
  const baseUrl = options.baseUrl ?? '';
  const instance = new MarkdownIt({
    html: false,
    linkify: true,
    breaks: false,
    typographer: false,
  });
  installImageRule(instance, baseUrl);

  if (options.sourceMap) {
    // Block tokens carry `map: [startLine, endLine]`. Stamping the start line on
    // the opening tag is all the editor needs to map a click back to the source;
    // inline tokens have no map, so images inherit their block's line.
    const renderToken = instance.renderer.renderToken.bind(instance.renderer);
    instance.renderer.renderToken = (tokens, idx, opts) => {
      const token = tokens[idx];
      if (token.map && token.nesting !== -1) {
        token.attrSet('data-source-line', String(token.map[0] + 1));
      }
      return renderToken(tokens, idx, opts);
    };
  }

  return instance.render(markdown);
}

/**
 * Plain-text summary for <meta name="description">. Derived from parsed tokens
 * rather than the raw source, so `## Heading`, `**bold**`, and link syntax don't
 * leak punctuation into the description.
 */
export function markdownExcerpt(markdown: string, maxLength = 160): string {
  const text = md
    .parse(markdown, {})
    .filter((token) => token.type === 'inline')
    .map((token) =>
      (token.children ?? [])
        .filter((child) => child.type === 'text' || child.type === 'code_inline')
        .map((child) => child.content)
        .join(''),
    )
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= maxLength) return text;
  // Cut on a word boundary so the summary doesn't end mid-word.
  const cut = text.slice(0, maxLength - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > maxLength / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * Every distinct media key the body references, discovered from parser tokens
 * rather than a regex — a regex would also match image syntax inside a fenced
 * code block, which renders as text and is not a real reference.
 *
 * External images and links are ignored: only objects served by this store can
 * be library associations.
 */
export function extractMediaKeys(markdown: string, options: RenderOptions = {}): string[] {
  const baseUrl = options.baseUrl ?? '';
  const keys = new Set<string>();
  const walk = (tokens: ReturnType<typeof md.parse>) => {
    for (const token of tokens) {
      if (token.type === 'image') {
        const key = localKeyFromSrc(token.attrGet('src') ?? '', baseUrl);
        if (key) keys.add(key);
      }
      if (token.children?.length) walk(token.children);
    }
  };
  walk(md.parse(markdown, {}));
  // A Set keeps insertion order, so repeated references collapse to one entry
  // and page_media never gets a duplicate row.
  return [...keys];
}
