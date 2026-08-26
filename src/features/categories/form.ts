import { parsePublicId } from '../ids/publicId';

/** Parsed category form fields (slug + parent resolved by the endpoint). */
export interface ParsedCategoryForm {
  name: string;
  slugInput: string;
  /** cat_ public ID from the parent selector; resolved to a row id at the boundary. */
  parentPublicId: string | null;
  members_only: number;
}

export function parseCategoryForm(
  form: FormData,
): { data: ParsedCategoryForm } | { error: string } {
  const name = String(form.get('name') ?? '').trim();
  if (!name) return { error: 'Name is required.' };

  const slugInput = String(form.get('slug') ?? '').trim();

  // The selector submits cat_ public IDs; numeric ids are not accepted.
  const parentRaw = String(form.get('parent_id') ?? '').trim();
  let parentPublicId: string | null = null;
  if (parentRaw) {
    parentPublicId = parsePublicId(parentRaw, 'category');
    if (!parentPublicId) return { error: 'Invalid parent category.' };
  }

  return { data: { name, slugInput, parentPublicId, members_only: form.get('members_only') != null ? 1 : 0 } };
}
