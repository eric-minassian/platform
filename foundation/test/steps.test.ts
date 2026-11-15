import { describe, expect, it } from 'vitest';
import config from '../../platform.config.ts';
import { STEPS } from '../src/steps.ts';

describe('foundation steps', () => {
  const ids = STEPS.map((s) => s.id);
  const before = (a: string, b: string) => expect(ids.indexOf(a)).toBeLessThan(ids.indexOf(b));

  it('runs in dependency order', () => {
    before('dns-zone', 'certificates'); // cert B validates in the delegated zone
    before('certificates', 'distribution'); // the distribution needs the wildcard cert
    before('routes', 'distribution'); // viewer-request function association
    before('edge-policies', 'distribution');
    before('dns-records', 'user-pool'); // Cognito custom domains need the parent A record
    before('user-pool', 'iam'); // control-plane policy is scoped to the pool
    before('iam', 'parameters'); // runtime config carries the boundary ARN
    before('parameters', 'control-plane');
    before('control-plane', 'telemetry'); // subscription targets the control plane worker
  });

  it('marks what the emulator cannot do', () => {
    const awsOnly = STEPS.filter((s) => s.awsOnly).map((s) => s.id);
    expect(awsOnly).toEqual(['dns-zone', 'certificates', 'distribution', 'dns-records']);
  });

  it('describes every step for --plan', () => {
    for (const s of STEPS) expect(s.describe(config).length).toBeGreaterThan(10);
  });
});
