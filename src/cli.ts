#!/usr/bin/env node
import { runCli } from './cli/run';

// a closed pipe (e.g. `umbrella-prs tree --json | head`) is not an error
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') process.exit(0);

    throw error;
  });
}

const exitCode = await runCli({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  env: process.env,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  isTTY: Boolean(process.stdin.isTTY && process.stderr.isTTY),
  // `git diff | umbrella-prs diff view -` still opens the viewer
  canOpenFiles: Boolean(process.stderr.isTTY),
});

process.exitCode = exitCode;
