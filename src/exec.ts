import { spawn } from 'node:child_process';

const safeArgRegex = /^[\w@%+=:,./-]+$/;

export type ExecResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export type Exec = (
  cmd: string,
  args: readonly string[],
  options?: { cwd?: string; input?: string },
) => Promise<ExecResult>;

export const defaultExec: Exec = (cmd, args, options = {}) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        GH_PROMPT_DISABLED: '1',
        GIT_TERMINAL_PROMPT: '0',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));

    child.on('error', (error) => {
      resolve({ code: 127, stdout: '', stderr: error.message });
    });

    child.on('close', (code) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });

    if (options.input !== undefined) child.stdin.write(options.input);

    child.stdin.end();
  });

export class CommandError extends Error {
  readonly result: ExecResult;
  readonly command: string;

  constructor(command: string, result: ExecResult) {
    super(
      `\`${command}\` failed with code ${result.code}: ${(result.stderr || result.stdout).trim()}`,
    );
    this.name = 'CommandError';
    this.result = result;
    this.command = command;
  }
}

export function formatCommand(cmd: string, args: readonly string[]) {
  return [cmd, ...args.map(quoteArg)].join(' ');
}

function quoteArg(arg: string) {
  if (safeArgRegex.test(arg)) return arg;

  return `'${arg.replaceAll("'", `'\\''`)}'`;
}
