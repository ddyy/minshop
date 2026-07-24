import { existsSync, rmSync } from 'node:fs';
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
  -h, --help     Show this help
  -v, --version  Show the installed create-minshop version
`;

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
