import type { createAgent } from '@ui-sdk/react/agent';
import { expect } from 'vitest';

/** Every component an agent can see on the page has a name; returns the names. */
export function expectNamed(agent: ReturnType<typeof createAgent>): string[] {
  const components = agent.snapshot().filter((e) => !e.offPage && e.component !== 'more');
  for (const entry of components)
    expect(entry.label, `${entry.component} ${entry.ref} has no name`).toBeTruthy();
  return components.map((e) => e.label ?? '');
}
