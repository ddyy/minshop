import { cpSync, existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

export const TEMPLATE_REPOSITORY = 'https://github.com/ddyy/minshop.git';
export const usage = `Create a new Minshop storefront.

Usage:
  npm create minshop@latest [directory] [options]
  npx create-minshop@latest [directory] [options]

Options:
  --no-install   Scaffold without installing dependencies
  --ref <ref>    Clone a specific Git branch or tag (default: main)
  --theme <id>   Name this store's theme (default: from the directory)
  -h, --help     Show this help
  -v, --version  Show the installed create-minshop version
`;

/** Ids upstream owns. A store may not claim one, or a later upstream release
 *  would have nowhere to put the set the name was held for. Kept in step with
 *  scripts/themes.mjs. */
export const RESERVED_THEME_IDS = ['default', 'studio', 'market'];

const THEME_ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** Mirrors isValidThemeId in scripts/themes.mjs — pattern AND length.
 *  The scaffolder must not accept an id the application later rejects: a
 *  41-character id would be copied, written into theme.config.json, and
 *  only then refused by the resolver, leaving the new store unable to build. */
function isUsableThemeId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 40 && THEME_ID.test(id);
}

/** Turn a directory or store name into a usable theme id. */
export function normalizeThemeId(name) {
  const slug = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return isUsableThemeId(slug) ? slug : null;
}

/**
 * The id for this store's own theme.
 *
 * Every store gets one. `src/themes/default/` is upstream's and is never
 * edited by a store — that separation is what lets upstream change the default
 * without colliding with a merchant's work, and it only holds if the scaffolder
 * creates the store's theme from the start.
 */
export function resolveThemeId(requested, directory) {
  if (requested != null) {
    const id = String(requested).trim();
    if (!isUsableThemeId(id)) {
      throw new Error(
        `Invalid theme id: "${id}". Use lowercase letters, digits, and single hyphens — at most 40 characters.`,
      );
    }
    if (RESERVED_THEME_IDS.includes(id)) {
      throw new Error(`"${id}" is reserved for an upstream theme. Choose another --theme id.`);
    }
    return id;
  }

  const derived = normalizeThemeId(basename(resolve(directory)));
  if (!derived) {
    throw new Error(
      `Cannot derive a theme id from "${directory}". Pass --theme <id> explicitly.`,
    );
  }
  // A directory literally named `minshop` is the common default, and `default`
  // is reserved, so suffix rather than fail on a name the user did not choose.
  return RESERVED_THEME_IDS.includes(derived) ? `${derived}-store` : derived;
}

export function assertSupportedNodeVersion(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  if ((major === 22 && minor >= 12) || major >= 24) return;
  throw new Error(
    `Node ${version} is unsupported. Use Node 22.12 or newer on the Node 22 line, or Node 24+.`,
  );
}

export function parseArguments(args) {
  const options = {
    directory: 'minshop',
    install: true,
    ref: 'main',
    theme: null,
    help: false,
    version: false,
  };
  let directorySeen = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--no-install') {
      options.install = false;
    } else if (argument === '--ref') {
      const ref = args[index + 1];
      if (!ref || ref.startsWith('-')) throw new Error('--ref requires a Git branch or tag.');
      options.ref = ref;
      index += 1;
    } else if (argument === '--theme') {
      const id = args[index + 1];
      if (!id || id.startsWith('-')) throw new Error('--theme requires a theme id.');
      options.theme = id;
      index += 1;
    } else if (argument === '-h' || argument === '--help') {
      options.help = true;
    } else if (argument === '-v' || argument === '--version') {
      options.version = true;
    } else if (argument.startsWith('-')) {
      throw new Error(`Unknown option: ${argument}`);
    } else if (directorySeen) {
      throw new Error('Provide only one target directory.');
    } else {
      options.directory = argument;
      directorySeen = true;
    }
  }

  return options;
}

function run(command, args, cwd, stdio) {
  const result = spawnSync(command, args, {
    cwd,
    stdio,
    env: process.env,
  });
  if (result.error) {
    if (result.error.code === 'ENOENT') {
      throw new Error(`${command} is required but was not found.`);
    }
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}.`);
  }
}

function shellPath(path) {
  return /\s/.test(path) ? JSON.stringify(path) : path;
}

export function scaffoldMinshop({
  directory = 'minshop',
  install = true,
  ref = 'main',
  theme = null,
  cwd = process.cwd(),
  repository = TEMPLATE_REPOSITORY,
  stdio = 'inherit',
} = {}) {
  assertSupportedNodeVersion();
  const target = resolve(cwd, directory);
  if (target === resolve(cwd)) {
    throw new Error('Choose a new directory instead of the current directory.');
  }
  if (existsSync(target)) {
    throw new Error(`Target already exists: ${target}`);
  }

  try {
    run('git', ['clone', '--depth', '1', '--branch', ref, repository, target], cwd, stdio);
  } catch (error) {
    rmSync(target, { recursive: true, force: true });
    throw error;
  }

  // A generated storefront should not inherit the template repository history or
  // package-maintainer release machinery.
  rmSync(resolve(target, '.git'), { recursive: true, force: true });
  rmSync(resolve(target, 'create-minshop'), { recursive: true, force: true });
  rmSync(resolve(target, '.github/workflows/publish-create-minshop.yml'), {
    force: true,
  });
  // This store's own theme. Copied from the upstream default and
  // selected immediately, so the store never has to edit an upstream file to
  // change its design — the boundary that keeps future upstream changes from
  // colliding with a merchant's work.
  const themeId = resolveThemeId(theme, target);
  const themesDir = resolve(target, 'src/themes');
  if (existsSync(resolve(themesDir, themeId))) {
    throw new Error(`Theme "${themeId}" already exists in the upstream repository. Pass --theme <id>.`);
  }
  cpSync(resolve(themesDir, 'default'), resolve(themesDir, themeId), { recursive: true });
  writeFileSync(
    resolve(target, 'theme.config.json'),
    `${JSON.stringify({ theme: themeId }, null, 2)}\n`,
  );

  run('git', ['init'], target, stdio);

  if (install) {
    run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci'], target, stdio);
    run(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['ci', '--prefix', 'mcp'],
      target,
      stdio,
    );
  }

  const relativeTarget = relative(cwd, target) || basename(target);
  return {
    target,
    relativeTarget,
    shellTarget: shellPath(relativeTarget),
  };
}
