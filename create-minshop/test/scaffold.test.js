import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  assertSupportedNodeVersion,
  normalizeThemeId,
  parseArguments,
  resolveThemeId,
  scaffoldMinshop,
} from '../src/scaffold.js';

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

function createTemplateRepository(root) {
  const repository = join(root, 'template');
  mkdirSync(join(repository, 'create-minshop'), { recursive: true });
  mkdirSync(join(repository, '.github', 'workflows'), { recursive: true });
  mkdirSync(join(repository, 'mcp'), { recursive: true });
  mkdirSync(join(repository, 'scripts'), { recursive: true });
  mkdirSync(join(repository, 'src', 'themes', 'default'), { recursive: true });
  // The REAL resolver and CI workflow, not stand-ins: the generated-store
  // matrix test below proves the actual discovery command covers the actual
  // themes a generated repository carries.
  writeFileSync(
    join(repository, 'scripts', 'themes.mjs'),
    readFileSync(new URL('../../scripts/themes.mjs', import.meta.url), 'utf8'),
  );
  writeFileSync(
    join(repository, '.github', 'workflows', 'verify.yml'),
    readFileSync(new URL('../../.github/workflows/verify.yml', import.meta.url), 'utf8'),
  );
  writeFileSync(
    join(repository, 'src', 'themes', 'default', 'ProductCard.astro'),
    '<li>card</li>\n',
  );
  writeFileSync(join(repository, 'src', 'themes', 'default', 'tokens.css'), ':root{}\n');
  writeFileSync(join(repository, 'theme.config.json'), '{\n  "theme": "default"\n}\n');
  writeFileSync(join(repository, 'package.json'), '{"name":"minshop","private":true}\n');
  writeFileSync(join(repository, 'store.txt'), 'storefront\n');
  writeFileSync(join(repository, 'create-minshop', 'package.json'), '{}\n');
  writeFileSync(
    join(repository, '.github', 'workflows', 'publish-create-minshop.yml'),
    'name: Publish\n',
  );
  run('git', ['init', '--initial-branch=main'], repository);
  run('git', ['add', '.'], repository);
  run(
    'git',
    [
      '-c',
      'user.name=Minshop Tests',
      '-c',
      'user.email=tests@example.com',
      'commit',
      '-m',
      'Initial template',
    ],
    repository,
  );
  return repository;
}

test('parses the npm create options', () => {
  assert.deepEqual(parseArguments(['my-store', '--no-install', '--ref', 'v1.2.3']), {
    directory: 'my-store',
    install: false,
    ref: 'v1.2.3',
    theme: null,
    help: false,
    version: false,
  });
});

test('accepts supported Node release lines', () => {
  assert.doesNotThrow(() => assertSupportedNodeVersion('22.12.0'));
  assert.doesNotThrow(() => assertSupportedNodeVersion('24.0.0'));
});

test('rejects unsupported Node release lines', () => {
  assert.throws(() => assertSupportedNodeVersion('22.11.0'), /unsupported/);
  assert.throws(() => assertSupportedNodeVersion('23.4.0'), /unsupported/);
});

test('scaffolds a clean storefront repository', () => {
  const root = mkdtempSync(join(tmpdir(), 'create-minshop-'));
  const repository = createTemplateRepository(root);

  const result = scaffoldMinshop({
    directory: 'new-store',
    install: false,
    cwd: root,
    repository,
    stdio: 'pipe',
  });

  assert.equal(readFileSync(join(result.target, 'store.txt'), 'utf8'), 'storefront\n');
  assert.equal(readFileSync(join(result.target, 'package.json'), 'utf8').includes('minshop'), true);
  assert.equal(spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: result.target,
    encoding: 'utf8',
  }).stdout.trim(), 'true');
  assert.equal(spawnSync('git', ['log', '-1'], {
    cwd: result.target,
    encoding: 'utf8',
  }).status, 128);
  assert.equal(existsSync(join(result.target, 'create-minshop')), false);
  assert.equal(
    existsSync(join(result.target, '.github', 'workflows', 'publish-create-minshop.yml')),
    false,
  );
});

test('refuses to overwrite an existing target', () => {
  const root = mkdtempSync(join(tmpdir(), 'create-minshop-'));
  mkdirSync(join(root, 'existing'));
  assert.throws(
    () =>
      scaffoldMinshop({
        directory: 'existing',
        install: false,
        cwd: root,
        repository: 'unused',
        stdio: 'pipe',
      }),
    /Target already exists/,
  );
});

test('derives a theme id from the target directory', () => {
  assert.equal(resolveThemeId(null, '/tmp/Acme Supply Co.'), 'acme-supply-co');
  assert.equal(resolveThemeId(null, '/tmp/bob-and-sons'), 'bob-and-sons');
});

test('suffixes rather than fails when the directory name is reserved', () => {
  // `minshop` is the documented default directory, and a store must not own the
  // upstream `default` theme — but the user did not choose that collision.
  assert.equal(resolveThemeId(null, '/tmp/default'), 'default-store');
});

test('rejects reserved and malformed theme ids', () => {
  // Reserved now, before any store exists: if a merchant could claim `studio`,
  // the upstream Studio example would have nowhere to land later.
  for (const reserved of ['default', 'studio', 'market']) {
    assert.throws(() => resolveThemeId(reserved, '/tmp/x'), /reserved/);
  }
  for (const bad of ['Acme', 'acme store', '-acme', 'acme-', '']) {
    assert.throws(() => resolveThemeId(bad, '/tmp/x'), /Invalid theme id/);
  }
});

test('enforces the application resolver 40-character limit on explicit ids', () => {
  // isValidThemeId in scripts/themes.mjs caps ids at 40 characters. An
  // explicit --theme that passes here but fails there scaffolds a store whose
  // committed config the application refuses — it cannot build at all.
  const forty = `a${'b'.repeat(39)}`;
  assert.equal(forty.length, 40);
  assert.equal(resolveThemeId(forty, '/tmp/x'), forty);
  assert.throws(() => resolveThemeId(`${forty}c`, '/tmp/x'), /Invalid theme id/);
});

test('normalizeThemeId returns null when nothing usable survives', () => {
  assert.equal(normalizeThemeId('!!!'), null);
});

test('gives the generated store its own theme, selected', () => {
  const root = mkdtempSync(join(tmpdir(), 'create-minshop-'));
  const repository = createTemplateRepository(root);

  const result = scaffoldMinshop({
    directory: 'acme-supply',
    install: false,
    cwd: root,
    repository,
    stdio: 'pipe',
  });

  // The store owns a named theme from its first commit, so it never has to edit
  // the upstream default — the boundary that keeps later upstream changes from
  // colliding with a merchant's work.
  assert.equal(existsSync(join(result.target, 'src/themes/acme-supply/ProductCard.astro')), true);
  assert.equal(existsSync(join(result.target, 'src/themes/default/ProductCard.astro')), true);
  assert.equal(
    JSON.parse(readFileSync(join(result.target, 'theme.config.json'), 'utf8')).theme,
    'acme-supply',
  );
});

test('the generated repository CI matrix discovers every theme it carries', () => {
  const root = mkdtempSync(join(tmpdir(), 'create-minshop-'));
  const repository = createTemplateRepository(root);

  const result = scaffoldMinshop({
    directory: 'acme-supply',
    install: false,
    cwd: root,
    repository,
    stdio: 'pipe',
  });

  // The workflow must derive its matrix, not enumerate upstream's themes: a
  // hardcoded list can never contain a merchant's own theme, so the store's
  // retained shipped themes would break without CI noticing.
  const workflow = readFileSync(join(result.target, '.github/workflows/verify.yml'), 'utf8');
  assert.equal(workflow.includes('discoverThemeIds'), true);
  assert.equal(workflow.includes('theme: [market, studio]'), false);

  // Run THE SAME discovery command the workflow runs, inside the generated
  // repository: the main job covers the merchant theme (named by the config),
  // so the matrix must be exactly the retained shipped themes.
  const discovery = spawnSync(
    'node',
    [
      '--input-type=module',
      '-e',
      `import { discoverThemeIds, resolveConfiguredTheme } from './scripts/themes.mjs';
       const configured = resolveConfiguredTheme().id;
       console.log(JSON.stringify(discoverThemeIds().filter((id) => id !== configured)));`,
    ],
    { cwd: result.target, encoding: 'utf8' },
  );
  assert.equal(discovery.status, 0, discovery.stderr);
  assert.deepEqual(JSON.parse(discovery.stdout.trim()), ['default']);
});

test('honours an explicit --theme id', () => {
  const root = mkdtempSync(join(tmpdir(), 'create-minshop-'));
  const repository = createTemplateRepository(root);

  const result = scaffoldMinshop({
    directory: 'new-store',
    theme: 'northwind',
    install: false,
    cwd: root,
    repository,
    stdio: 'pipe',
  });

  assert.equal(existsSync(join(result.target, 'src/themes/northwind')), true);
  assert.equal(
    JSON.parse(readFileSync(join(result.target, 'theme.config.json'), 'utf8')).theme,
    'northwind',
  );
});

test('parses --theme', () => {
  assert.equal(parseArguments(['--theme', 'northwind']).theme, 'northwind');
  assert.throws(() => parseArguments(['--theme']), /requires a theme id/);
});
