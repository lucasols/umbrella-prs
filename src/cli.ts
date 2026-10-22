#!/usr/bin/env node
import { runCli } from './cli/run';

const exitCode = await runCli({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  env: process.env,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  isTTY: Boolean(process.stdin.isTTY && process.stderr.isTTY),
});

process.exitCode = exitCode;
