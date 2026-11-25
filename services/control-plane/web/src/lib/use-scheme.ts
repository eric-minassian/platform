import { usePreference } from '@ui-sdk/react/preferences';
import { colorScheme } from './color-scheme.ts';

/** The scheme in use, for the few colors drawn from script, like the heatmap's ramp. */
export function useResolvedScheme(): 'light' | 'dark' {
  return usePreference(colorScheme).resolved === 'dark' ? 'dark' : 'light';
}
