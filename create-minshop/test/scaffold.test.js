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
  normalizeSetId,
  parseArguments,
  resolveSetId,
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
  mkdirSync(join(repository, 'src', 'storefront', 'default'), { recursive: true });
  writeFileSync(
    join(repository, 'src', 'storefront', 'default', 'ProductCard.astro'),
    '<li>card</li>\n',
  );
  writeFileSync(join(repository, 'src', 'storefront', 'default', 'theme.css'), ':root{}\n');
  writeFileSync(join(repository, 'storefront.config.json'), '{\n  "set": "default"\n}\n');
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
    set: null,
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

test('derives a storefront set id from the target directory', () => {
  assert.equal(resolveSetId(null, '/tmp/Acme Supply Co.'), 'acme-supply-co');
  assert.equal(resolveSetId(null, '/tmp/bob-and-sons'), 'bob-and-sons');
});

test('suffixes rather than fails when the directory name is reserved', () => {
  // `minshop` is the documented default directory, and a store must not own the
  // upstream `default` set — but the user did not choose that collision.
  assert.equal(resolveSetId(null, '/tmp/default'), 'default-store');
});

test('rejects reserved and malformed storefront set ids', () => {
  // Reserved now, before any store exists: if a merchant could claim `studio`,
  // the upstream Studio example would have nowhere to land later.
  for (const reserved of ['default', 'studio', 'market']) {
    assert.throws(() => resolveSetId(reserved, '/tmp/x'), /reserved/);
  }
  for (const bad of ['Acme', 'acme store', '-acme', 'acme-', '']) {
    assert.throws(() => resolveSetId(bad, '/tmp/x'), /Invalid storefront set id/);
  }
});

test('normalizeSetId returns null when nothing usable survives', () => {
  assert.equal(normalizeSetId('!!!'), null);
});

test('gives the generated store its own storefront set, selected', () => {
  const root = mkdtempSync(join(tmpdir(), 'create-minshop-'));
  const repository = createTemplateRepository(root);

  const result = scaffoldMinshop({
    directory: 'acme-supply',
    install: false,
    cwd: root,
    repository,
    stdio: 'pipe',
  });

  // The store owns a named set from its first commit, so it never has to edit
  // the upstream default — the boundary that keeps later upstream changes from
  // colliding with a merchant's work.
  assert.equal(existsSync(join(result.target, 'src/storefront/acme-supply/ProductCard.astro')), true);
  assert.equal(existsSync(join(result.target, 'src/storefront/default/ProductCard.astro')), true);
  assert.equal(
    JSON.parse(readFileSync(join(result.target, 'storefront.config.json'), 'utf8')).set,
    'acme-supply',
  );
});

test('honours an explicit --set id', () => {
  const root = mkdtempSync(join(tmpdir(), 'create-minshop-'));
  const repository = createTemplateRepository(root);

  const result = scaffoldMinshop({
    directory: 'new-store',
    set: 'northwind',
    install: false,
    cwd: root,
    repository,
    stdio: 'pipe',
  });

  assert.equal(existsSync(join(result.target, 'src/storefront/northwind')), true);
  assert.equal(
    JSON.parse(readFileSync(join(result.target, 'storefront.config.json'), 'utf8')).set,
    'northwind',
  );
});

test('parses --set', () => {
  assert.equal(parseArguments(['--set', 'northwind']).set, 'northwind');
  assert.throws(() => parseArguments(['--set']), /requires a storefront set id/);
});
