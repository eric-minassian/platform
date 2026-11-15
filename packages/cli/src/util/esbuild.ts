/** An esbuild failure as `file:line: message` items (or the error's message), for a CliError list. */
export function buildFailureList(err: unknown): string {
  const errors = (
    err as { errors?: Array<{ text: string; location?: { file: string; line: number } | null }> }
  ).errors;
  const lines = errors?.length
    ? errors.map((e) => (e.location ? `${e.location.file}:${e.location.line}: ${e.text}` : e.text))
    : [(err as Error).message];
  return `\n  - ${lines.join('\n  - ')}`;
}
