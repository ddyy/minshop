const MAX_TITLE = 120;
const MAX_BODY = 100_000;

export interface PageFields {
  title: string;
  /** Raw slug as typed; '' means "derive it from the title". */
  slug: string;
  body_markdown: string;
  published: number;
}

/**
 * Parse and validate the page form. Returns either the fields or a single
 * user-facing message, matching parseProductForm's shape.
 */
export function parsePageForm(form: FormData): { data: PageFields } | { error: string } {
  const title = String(form.get('title') ?? '').trim();
  if (!title) return { error: 'Title is required.' };
  if (title.length > MAX_TITLE) {
    return { error: `Title must be ${MAX_TITLE} characters or fewer.` };
  }

  const body = String(form.get('body_markdown') ?? '');
  if (body.length > MAX_BODY) {
    return { error: `Page content must be ${MAX_BODY.toLocaleString()} characters or fewer.` };
  }

  return {
    data: {
      title,
      slug: String(form.get('slug') ?? '').trim(),
      body_markdown: body,
      // Checkbox: present = on. Any other truthy encoding ('1', 'true') also works.
      published: form.get('published') ? 1 : 0,
    },
  };
}
