import { describe, expect, it } from 'vitest';
import { repoVisibilityOf } from '../src/control-plane.ts';

describe('the control plane’s own deploy', () => {
  it('takes its repository’s visibility from the Actions event it runs in', () => {
    // A `workflow_run` payload, as deploy-platform.yml runs on.
    expect(
      repoVisibilityOf({
        action: 'completed',
        repository: { full_name: 'o/platform', visibility: 'public' },
      }),
    ).toBe('public');
    expect(repoVisibilityOf({ repository: { visibility: 'private' } })).toBe('private');
    expect(repoVisibilityOf({ repository: { visibility: 'secret' } })).toBeUndefined();
    expect(repoVisibilityOf({ repository: {} })).toBeUndefined();
    expect(repoVisibilityOf(null)).toBeUndefined();
  });
});
