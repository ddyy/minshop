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
  parseArguments,
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
