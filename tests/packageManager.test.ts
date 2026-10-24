import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { detectCliCommand } from '../src/cli/packageManager';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function createRepo(files: Record<string, string>) {
  const dir = mkdtempSync(path.join(tmpdir(), 'umbrella-prs-pm-'));
  dirs.push(dir);
  mkdirSync(path.join(dir, '.git'));

  for (const [file, contents] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), contents);
  }

  return dir;
}

const withDependency = JSON.stringify({
  devDependencies: { '@ls-stack/umbrella-prs': '^0.7.0' },
});

describe('detectCliCommand', () => {
  test('uses the bin when the package is not a dependency', () => {
    const dir = createRepo({
      'package.json': '{}',
      'pnpm-lock.yaml': '',
    });

    expect(detectCliCommand({ cwd: dir, env: {} })).toBe('umbrella-prs');
  });

  test('detects the package manager from the lockfile', () => {
    expect(
      detectCliCommand({
        cwd: createRepo({
          'package.json': withDependency,
          'pnpm-lock.yaml': '',
        }),
        env: {},
      }),
    ).toBe('pnpm exec umbrella-prs');

    expect(
      detectCliCommand({
        cwd: createRepo({ 'package.json': withDependency, 'yarn.lock': '' }),
        env: {},
      }),
    ).toBe('yarn umbrella-prs');

    expect(
      detectCliCommand({
        cwd: createRepo({ 'package.json': withDependency, 'bun.lock': '' }),
        env: {},
      }),
    ).toBe('bunx umbrella-prs');

    expect(
      detectCliCommand({
        cwd: createRepo({
          'package.json': withDependency,
          'package-lock.json': '{}',
        }),
        env: {},
      }),
    ).toBe('npx umbrella-prs');
  });

  test('prefers the packageManager field over the lockfile', () => {
    const dir = createRepo({
      'package.json': JSON.stringify({
        packageManager: 'pnpm@9.15.0',
        devDependencies: { '@ls-stack/umbrella-prs': '^0.7.0' },
      }),
      'package-lock.json': '{}',
    });

    expect(detectCliCommand({ cwd: dir, env: {} })).toBe(
      'pnpm exec umbrella-prs',
    );
  });

  test('finds the dependency in a workspace package and the lockfile at the root', () => {
    const dir = createRepo({
      'package.json': '{}',
      'pnpm-lock.yaml': '',
      'packages/app/package.json': withDependency,
    });

    expect(
      detectCliCommand({ cwd: path.join(dir, 'packages/app'), env: {} }),
    ).toBe('pnpm exec umbrella-prs');
  });

  test('falls back to the user agent, then npm', () => {
    const dir = createRepo({ 'package.json': withDependency });

    expect(
      detectCliCommand({
        cwd: dir,
        env: { npm_config_user_agent: 'yarn/1.22.22 npm/? node/v22.0.0' },
      }),
    ).toBe('yarn umbrella-prs');

    expect(detectCliCommand({ cwd: dir, env: {} })).toBe('npx umbrella-prs');
  });
});
