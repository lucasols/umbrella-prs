import { createInterface } from 'node:readline/promises';

export type Prompter = {
  text: (
    message: string,
    options?: { initial?: string; validate?: (value: string) => string | true },
  ) => Promise<string>;
  select: <T extends string>(
    message: string,
    options: { value: T; label: string; hint?: string }[],
  ) => Promise<T>;
  confirm: (message: string) => Promise<boolean>;
};

export class PromptCancelledError extends Error {
  constructor() {
    super('Prompt cancelled');
    this.name = 'PromptCancelledError';
  }
}

/** Minimal readline prompts, keeps the CLI free of runtime dependencies */
export function createReadlinePrompter({
  input = process.stdin,
  output = process.stderr,
}: {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
} = {}): Prompter {
  async function ask(question: string): Promise<string> {
    const rl = createInterface({ input, output, terminal: true });
    const controller = new AbortController();

    rl.on('SIGINT', () => controller.abort());

    try {
      return await rl.question(question, { signal: controller.signal });
    } catch {
      throw new PromptCancelledError();
    } finally {
      rl.close();
    }
  }

  return {
    async text(message, { initial, validate } = {}) {
      for (;;) {
        const answer = await ask(
          `? ${message}${initial ? ` (${initial})` : ''}: `,
        );
        const value = answer.trim() || initial || '';
        const validation = validate ? validate(value) : true;

        if (validation === true) return value;

        output.write(`  ${validation}\n`);
      }
    },

    async select(message, options) {
      output.write(`? ${message}\n`);

      for (const [index, option] of options.entries()) {
        output.write(
          `  ${index + 1}) ${option.label}${option.hint ? `  (${option.hint})` : ''}\n`,
        );
      }

      for (;;) {
        const answer = (await ask(`  Select 1-${options.length}: `)).trim();
        const option = options[Number(answer) - 1];

        if (option) return option.value;

        const byValue = options.find((item) => item.value === answer);

        if (byValue) return byValue.value;
      }
    },

    async confirm(message) {
      const answer = await ask(`? ${message} (y/N): `);

      return /^y(es)?$/i.test(answer.trim());
    },
  };
}
