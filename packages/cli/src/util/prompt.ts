import { createInterface } from 'node:readline/promises';
import { CliError, EXIT } from './output.ts';

export async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/** Ask the user to type `expected` back; `--yes` skips it, and non-interactive runs must pass it. */
export async function confirmByTyping(question: string, expected: string, yes?: boolean): Promise<void> {
  if (yes) return;
  if (!process.stdin.isTTY)
    throw new CliError('confirmation needed', { hint: 'pass --yes', exitCode: EXIT.usage });
  const answer = await prompt(`${question} type ${expected} to confirm: `);
  if (answer.trim() !== expected) throw new CliError('aborted', { exitCode: EXIT.usage });
}
