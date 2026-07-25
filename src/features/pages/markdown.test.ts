import { describe, it, expect } from 'vitest';
import { renderMarkdown, markdownExcerpt, extractMediaKeys } from './markdown';

describe('renderMarkdown — structure', () => {
  it('renders headings, lists, links, and emphasis', () => {
    const html = renderMarkdown('## Shipping\n\n- one\n- two\n\n[Contact](/pages/contact) and **bold**.');
    expect(html).toContain('<h2>Shipping</h2>');
    expect(html).toContain('<li>one</li>');
    expect(html).toContain('<a href="/pages/contact">Contact</a>');
    expect(html).toContain('<strong>bold</strong>');
  });

  it('renders fenced code as escaped text, not markup', () => {
    const html = renderMarkdown('```\n<b>not bold</b>\n```');
    expect(html).toContain('&lt;b&gt;not bold&lt;/b&gt;');
    expect(html).not.toContain('<b>not bold</b>');
  });
});

describe('renderMarkdown — safety', () => {
  it('escapes raw HTML instead of parsing it', () => {
    const html = renderMarkdown('<script>alert(1)</script>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes inline event handlers written as HTML', () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)">');
    expect(html).not.toContain('onerror="alert(1)"');
    expect(html).toContain('&lt;img');
  });

  // markdown-it refuses to build a link/image for a blocked scheme and leaves
  // the source as literal text, so assert on the absence of the ELEMENT, not of
  // the substring — the raw text legitimately still contains "javascript:".
  it('refuses to build a link for a javascript: target', () => {
    const html = renderMarkdown('[click](javascript:alert(1))');
    expect(html).not.toMatch(/href=/);
    expect(html).not.toContain('<a');
  });

  it('refuses to build an image for a javascript: source', () => {
    const html = renderMarkdown('![x](javascript:alert(1))');
    expect(html).not.toMatch(/<img/);
  });

  it('refuses vbscript: targets too', () => {
    expect(renderMarkdown('[c](vbscript:msgbox(1))')).not.toContain('<a');
  });

  // The quotes are escaped, so `onerror=` survives as inert TEXT inside the
  // attribute value. The property that matters is that it never becomes a real
  // attribute, which requires an unescaped quote — hence matching on `onerror="`
  // rather than on the bare substring.
  it('escapes quotes in alt text so it cannot break out of the attribute', () => {
    const html = renderMarkdown('![Tote " onerror="alert(1)](/images/media/a.png)');
    expect(html).not.toMatch(/\sonerror="/);
    expect(html).toContain('alt="Tote &quot; onerror=&quot;alert(1)"');
  });

  it('escapes quotes in the title attribute', () => {
    const html = renderMarkdown('![a](/images/media/a.png "x\\" onerror=\\"alert(1)")');
    expect(html).not.toMatch(/\sonerror="/);
    expect(html).toContain('title="x&quot; onerror=&quot;alert(1)"');
  });

  it('keeps ordinary external links working', () => {
    const html = renderMarkdown('[docs](https://example.com/guide)');
    expect(html).toContain('href="https://example.com/guide"');
  });
});

describe('renderMarkdown — images', () => {
  it('keeps the author-written alt text', () => {
    // Overriding markdown-it's image rule drops alt unless it is repopulated;
    // this is the regression guard for that.
    expect(renderMarkdown('![A tote bag](/images/media/a.webp)')).toContain('alt="A tote bag"');
  });

  it('marks body images lazy and async', () => {
    const html = renderMarkdown('![Tote](/images/media/tote.webp)');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('decoding="async"');
  });

  it('serves local images through the Worker route by default', () => {
    expect(renderMarkdown('![a](/images/media/a.webp)')).toContain('src="/images/media/a.webp"');
  });

  it('rewrites local images to the configured image origin', () => {
    const html = renderMarkdown('![a](/images/media/a.webp)', {
      baseUrl: 'https://images.example.com',
    });
    expect(html).toContain('src="https://images.example.com/media/a.webp"');
  });

  it('leaves external images on their own origin', () => {
    const html = renderMarkdown('![a](https://cdn.example.org/a.png)', {
      baseUrl: 'https://images.example.com',
    });
    expect(html).toContain('src="https://cdn.example.org/a.png"');
  });
});

describe('renderMarkdown — source map', () => {
  it('is off by default, so storefront HTML carries no editor plumbing', () => {
    expect(renderMarkdown('# Title\n\nBody.')).not.toContain('data-source-line');
  });

  it('stamps the start line on block elements when enabled', () => {
    const html = renderMarkdown('# Title\n\nSecond block.', { sourceMap: true });
    expect(html).toMatch(/<h1 [^>]*data-source-line="1"/);
    expect(html).toMatch(/<p [^>]*data-source-line="3"/);
  });

  it('numbers lines from 1, matching what an editor shows', () => {
    const html = renderMarkdown('\n\n\nFourth line.', { sourceMap: true });
    expect(html).toContain('data-source-line="4"');
  });

  it('maps list items so a click inside a list still resolves', () => {
    const html = renderMarkdown('- one\n- two', { sourceMap: true });
    expect(html).toMatch(/<li [^>]*data-source-line="1"/);
    expect(html).toMatch(/<li [^>]*data-source-line="2"/);
  });

  it('does not change the rendered content itself', () => {
    const plain = renderMarkdown('## Heading\n\n**bold**');
    const mapped = renderMarkdown('## Heading\n\n**bold**', { sourceMap: true });
    expect(mapped.replace(/ data-source-(line|end)="\d+"/g, '')).toBe(plain);
  });
});

describe('extractMediaKeys', () => {
  it('finds root-relative references', () => {
    expect(extractMediaKeys('![a](/images/media/a.webp)')).toEqual(['media/a.webp']);
  });

  it('finds references written against the configured image origin', () => {
    const keys = extractMediaKeys('![a](https://images.example.com/media/a.webp)', {
      baseUrl: 'https://images.example.com',
    });
    expect(keys).toEqual(['media/a.webp']);
  });

  it('collapses duplicate references to one key', () => {
    const keys = extractMediaKeys(
      '![a](/images/media/a.webp)\n\n![again](/images/media/a.webp)',
    );
    expect(keys).toEqual(['media/a.webp']);
  });

  it('ignores external images', () => {
    expect(extractMediaKeys('![a](https://cdn.example.org/a.png)')).toEqual([]);
  });

  it('ignores image syntax inside a code block, which renders as text', () => {
    expect(extractMediaKeys('```\n![a](/images/media/a.webp)\n```')).toEqual([]);
  });

  it('finds legacy product keys, since any media item can be reused', () => {
    expect(extractMediaKeys('![a](/images/products/old.jpg)')).toEqual(['products/old.jpg']);
  });

  it('returns nothing for a body with no images', () => {
    expect(extractMediaKeys('Just **text** and a [link](/pages/x).')).toEqual([]);
  });
});

describe('markdownExcerpt', () => {
  it('strips Markdown punctuation rather than copying the raw source', () => {
    const excerpt = markdownExcerpt('## Returns\n\nWe accept **returns** within [30 days](/x).');
    expect(excerpt).toBe('Returns We accept returns within 30 days.');
  });

  it('truncates on a word boundary with an ellipsis', () => {
    const excerpt = markdownExcerpt('word '.repeat(60), 40);
    expect(excerpt.length).toBeLessThanOrEqual(40);
    expect(excerpt.endsWith('…')).toBe(true);
    expect(excerpt).not.toMatch(/wo…$/);
  });

  it('returns an empty string for an empty body', () => {
    expect(markdownExcerpt('')).toBe('');
  });
});

describe('renderMarkdown — block extent', () => {
  it('stamps an exclusive end line so a block’s source range is known', () => {
    // The editor needs the range, not just the start, to map a click inside the
    // text to a character offset instead of selecting the whole line.
    const html = renderMarkdown('Alpha\nstill alpha\n\nBeta.', { sourceMap: true });
    expect(html).toMatch(/<p [^>]*data-source-line="1"[^>]*data-source-end="3"/);
    expect(html).toMatch(/<p [^>]*data-source-line="4"[^>]*data-source-end="5"/);
  });
});
