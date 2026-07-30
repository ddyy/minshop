/**
 * The one place that decides which storefront set is active.
 *
 * Imported by astro.config.mjs, vitest.config.ts, the generated-CSS step, the
 * boundary checker, and deploy validation. Nothing re-derives the id: two
 * readers with slightly different rules eventually disagree, and the symptom is
 * a build that compiles one design and styles another.
 *
 * Selection is BUILD TIME. The active set is baked into a deployment; it is
 * never read from a request.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const SETS_DIR = 'src/storefront';
export const CONFIG_FILE = 'storefront.config.json';

/** Ids upstream owns. A store may not claim one, or a later upstream release
 *  would have nowhere to put the set the name was held for. `studio` and
 *  `market` are frozen here before the scaffolder can generate stores, even
 *  though those designs do not exist yet — reserving a string costs nothing;
 *  reclaiming one after stores exist costs a migration. */
export const RESERVED_SET_IDS = ['default', 'studio', 'market'];

/** Lowercase, digits, single inner hyphens. Deliberately narrow: this becomes a
 *  directory name, an import specifier, and a configuration value. */
const SET_ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export function isValidSetId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 40 && SET_ID.test(id);
}

/** Turn a free-form name into a usable id, or null when nothing survives. */
export function normalizeSetId(name) {
  const slug = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return isValidSetId(slug) ? slug : null;
}

/** Every set present in the tree, sorted. Discovery is dynamic so a generated
 *  store's own set is covered without editing any list. */
export function discoverSetIds(root = process.cwd()) {
  const dir = resolve(root, SETS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => isValidSetId(name) && statSync(join(dir, name)).isDirectory())
    .sort();
}

export function setPath(id, root = process.cwd()) {
  if (!isValidSetId(id)) throw new Error(storefrontError(`"${id}" is not a valid storefront set id.`, root));
  // Resolved and re-checked rather than concatenated: an id that escaped the
  // parent would be a path-traversal bug in a build script.
  const dir = resolve(root, SETS_DIR, id);
  const parent = resolve(root, SETS_DIR);
  if (dir !== join(parent, id)) throw new Error(storefrontError(`"${id}" does not resolve inside ${SETS_DIR}/.`, root));
  return dir;
}

function storefrontError(message, root) {
  const available = discoverSetIds(root);
  return [
    message,
    available.length > 0
      ? `Available sets: ${available.join(', ')}`
      : `No sets found under ${SETS_DIR}/.`,
    `Set one in ${CONFIG_FILE} ({ "set": "…" }) or via the STOREFRONT environment variable.`,
  ].join('\n');
}

/**
 * The active set id.
 *
 * Fails closed. An explicit STOREFRONT wins; otherwise the config file must
 * exist and name a valid, present set. There is no invented fallback to
 * `default`: once the scaffolder writes a store's own id into the config, a
 * store that lost the file would otherwise build and deploy the UPSTREAM design
 * in place of its own, passing every check on the way. A fresh clone builds
 * `default` because its committed config says so.
 */
export function resolveStorefrontSet(root = process.cwd()) {
  const override = process.env.STOREFRONT?.trim();
  const source = override ? 'the STOREFRONT environment variable' : CONFIG_FILE;
  let id = override;

  if (!id) {
    const file = resolve(root, CONFIG_FILE);
    if (!existsSync(file)) {
      throw new Error(storefrontError(`Missing ${CONFIG_FILE}.`, root));
    }
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      throw new Error(storefrontError(`${CONFIG_FILE} is not valid JSON: ${error.message}`, root));
    }
    id = typeof parsed?.set === 'string' ? parsed.set.trim() : '';
    if (!id) throw new Error(storefrontError(`${CONFIG_FILE} has no "set" string.`, root));
  }

  if (!isValidSetId(id)) {
    throw new Error(storefrontError(`${source} names "${id}", which is not a valid set id.`, root));
  }
  const dir = setPath(id, root);
  if (!existsSync(dir)) {
    throw new Error(storefrontError(`${source} names "${id}", which does not exist.`, root));
  }
  return { id, dir, source };
}
