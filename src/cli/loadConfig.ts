import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseConfig, type UmbrellaConfig } from '../config';
import { isRecord } from '../utils.typeGuards';
import { err, ok, type Result } from '../result';

export const CONFIG_FILE_NAME = 'umbrella-prs.config.json';
export const PACKAGE_JSON_KEY = 'umbrellaPrs';

const configExample = `{ "types": { "feature": "main" } }`;

export type LoadConfigError = { message: string; fix: string };

/**
 * Loads `--config`, or the closest `umbrella-prs.config.json` or package.json
 * with an `umbrellaPrs` key, walking up from `cwd`
 */
export function loadConfig({
  cwd,
  configPath,
}: {
  cwd: string;
  configPath: string | undefined;
}): Result<{ config: UmbrellaConfig; path: string }, LoadConfigError> {
  if (configPath !== undefined) {
    const filePath = path.resolve(cwd, configPath);

    if (!existsSync(filePath)) {
      return err({
        message: `Config file ${filePath} not found`,
        fix: 'Check the `--config` path',
      });
    }

    return readConfigFile(filePath, null) ?? missingConfig();
  }

  let dir = path.resolve(cwd);

  for (;;) {
    const configFile = path.join(dir, CONFIG_FILE_NAME);

    if (existsSync(configFile)) {
      return readConfigFile(configFile, null) ?? missingConfig();
    }

    const packageJson = path.join(dir, 'package.json');

    if (existsSync(packageJson)) {
      const result = readConfigFile(packageJson, PACKAGE_JSON_KEY);

      if (result) return result;
    }

    if (existsSync(path.join(dir, '.git'))) break;

    const parent = path.dirname(dir);

    if (parent === dir) break;

    dir = parent;
  }

  return missingConfig();
}

function missingConfig() {
  return err<LoadConfigError>({
    message: `No ${CONFIG_FILE_NAME} found`,
    fix: `Create ${CONFIG_FILE_NAME} at the repo root, e.g. ${configExample}, or pass \`--config <path>\``,
  });
}

/** `null` when `key` is missing from the file */
function readConfigFile(
  filePath: string,
  key: string | null,
): Result<{ config: UmbrellaConfig; path: string }, LoadConfigError> | null {
  let json: unknown;

  try {
    json = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    return err({
      message: `Invalid JSON in ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      fix: 'Fix the JSON syntax',
    });
  }

  let value: unknown = json;

  if (key !== null) {
    if (!isRecord(json) || json[key] === undefined) return null;

    value = json[key];
  }

  const config = parseConfig(value);

  if (!config.ok) {
    return err({
      message: `Invalid config in ${filePath}${key ? ` (${key})` : ''}: ${config.error.message}`,
      fix: `Fix the config, e.g. ${configExample}`,
    });
  }

  return ok({ config: config.value, path: filePath });
}
