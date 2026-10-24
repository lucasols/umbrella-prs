import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { isRecord } from '../utils.typeGuards';

const packageName = '@ls-stack/umbrella-prs';
const binName = 'umbrella-prs';

const packageManagers = ['pnpm', 'yarn', 'bun', 'npm'] as const;

type PackageManager = (typeof packageManagers)[number];

const lockFiles: [string, PackageManager][] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
];

const runBin: Record<PackageManager, string> = {
  pnpm: `pnpm exec ${binName}`,
  yarn: `yarn ${binName}`,
  bun: `bunx ${binName}`,
  npm: `npx ${binName}`,
};

const packageManagerRegex = /^(pnpm|yarn|bun|npm)\b/;

/**
 * Command that runs the CLI in the repo, used in the commands the CLI suggests,
 * e.g. `pnpm exec umbrella-prs` when it is a dependency of a pnpm project, or
 * `umbrella-prs` when it is installed globally
 */
export function detectCliCommand({
  cwd,
  env,
}: {
  cwd: string;
  env: Record<string, string | undefined>;
}): string {
  let isDependency = false;
  let packageManager: PackageManager | null = null;
  let dir = path.resolve(cwd);

  // up to the repo root, the dependency can be in a workspace package and the
  // lockfile at the root
  for (;;) {
    const packageJson = readPackageJson(path.join(dir, 'package.json'));

    if (packageJson) {
      isDependency ||= hasDependency(packageJson);
      packageManager ??= parsePackageManager(packageJson.packageManager);
    }

    packageManager ??=
      lockFiles.find(([file]) => existsSync(path.join(dir, file)))?.[1] ?? null;

    if (existsSync(path.join(dir, '.git'))) break;

    const parent = path.dirname(dir);

    if (parent === dir) break;

    dir = parent;
  }

  if (!isDependency) return binName;

  return runBin[
    packageManager ?? parsePackageManager(env.npm_config_user_agent) ?? 'npm'
  ];
}

function readPackageJson(filePath: string): Record<string, unknown> | null {
  if (!existsSync(filePath)) return null;

  try {
    const json: unknown = JSON.parse(readFileSync(filePath, 'utf8'));

    return isRecord(json) ? json : null;
  } catch {
    return null;
  }
}

function hasDependency(packageJson: Record<string, unknown>) {
  return ['dependencies', 'devDependencies', 'optionalDependencies'].some(
    (key) => {
      const dependencies = packageJson[key];

      return isRecord(dependencies) && dependencies[packageName] !== undefined;
    },
  );
}

/** From the `packageManager` field, e.g. `pnpm@9.0.0`, or the npm user agent */
function parsePackageManager(value: unknown): PackageManager | null {
  if (typeof value !== 'string') return null;

  const name = packageManagerRegex.exec(value)?.[1];

  return packageManagers.find((manager) => manager === name) ?? null;
}
