/** Parsed category form fields (slug + parent resolved by the endpoint). */
export interface ParsedCategoryForm {
  name: string;
  slugInput: string;
  parentId: number | null;
}

export function parseCategoryForm(
  form: FormData,
): { data: ParsedCategoryForm } | { error: string } {
  const name = String(form.get('name') ?? '').trim();
  if (!name) return { error: 'Name is required.' };

  const slugInput = String(form.get('slug') ?? '').trim();

  const parentRaw = String(form.get('parent_id') ?? '').trim();
  let parentId: number | null = null;
  if (parentRaw) {
    parentId = Number(parentRaw);
    if (!Number.isInteger(parentId)) return { error: 'Invalid parent category.' };
  }

  return { data: { name, slugInput, parentId } };
}
