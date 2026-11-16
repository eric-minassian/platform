import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import {
  describeContainerSize,
  estimateContainerCost,
  fargateMemoryOptions,
  fargateSizeIssue,
  names,
  parseManifest,
  ResolvedManifest,
} from '../src/index.ts';

describe('fargate sizes', () => {
  it('accepts the pairs Fargate runs', () => {
    expect(fargateSizeIssue(0.25, 512)).toBeNull();
    expect(fargateSizeIssue(0.5, 4096)).toBeNull();
    expect(fargateSizeIssue(4, 30720)).toBeNull();
    expect(fargateMemoryOptions(1)).toEqual([2048, 3072, 4096, 5120, 6144, 7168, 8192]);
  });

  it('explains a pair it refuses', () => {
    expect(fargateSizeIssue(0.25, 4096)).toBe("memoryMb 4096 doesn't fit 0.25 vCPU: use 512, 1024, 2048");
    expect(fargateSizeIssue(2, 2048)).toBe(
      "memoryMb 2048 doesn't fit 2 vCPU: use 4096-16384 in steps of 1024",
    );
    expect(fargateSizeIssue(3, 4096)).toMatch(/cpu must be one of/);
  });
});

describe('container cost estimates', () => {
  it('prices a month of the smallest task', () => {
    expect(estimateContainerCost({ cpu: 0.25, memoryMb: 512, spot: false })).toEqual({
      computeUsd: 7.21,
      publicIpv4Usd: 3.65,
      totalUsd: 10.86,
    });
    const spot = estimateContainerCost({ cpu: 0.25, memoryMb: 512, spot: true });
    expect(spot.computeUsd).toBeCloseTo(2.21, 2);
    expect(spot.totalUsd).toBeCloseTo(5.86, 2);
    expect(describeContainerSize({ cpu: 0.25, memoryMb: 512, spot: true })).toBe('0.25 vCPU · 512 MB · Spot');
  });
});

describe('services in the manifest', () => {
  it('applies defaults', () => {
    const m = parseManifest({ name: 'atlas', services: { ais: { entry: 'src/ais.ts' } } });
    expect(m.services).toEqual({
      ais: { entry: 'src/ais.ts', cpu: 0.25, memoryMb: 512, spot: true, previewMinutes: 30 },
    });
    expect(m.worker).toBeUndefined();
  });

  it('refuses sizes Fargate does not run, at the field', () => {
    expect(() =>
      parseManifest({ name: 'atlas', services: { ais: { entry: 'src/ais.ts', cpu: 0.25, memoryMb: 4096 } } }),
    ).toThrow(/services\.ais\.memoryMb: memoryMb 4096 doesn't fit 0\.25 vCPU/);
    expect(() =>
      parseManifest({ name: 'atlas', services: { ais: { entry: 'src/ais.ts', cpu: 3 } } }),
    ).toThrow(/services\.ais\.cpu/);
  });

  it('refuses names that are not resource keys', () => {
    expect(() => parseManifest({ name: 'atlas', services: { AIS: { entry: 'src/ais.ts' } } })).toThrow(
      /services\.AIS: must be 1-20 chars/,
    );
  });

  it('decodes deployments stored before services existed', () => {
    const stored = { ...parseManifest({ name: 'atlas' }) } as Record<string, unknown>;
    delete stored.services;
    expect(Schema.decodeUnknownSync(ResolvedManifest)(stored).services).toEqual({});
  });

  it('names a service and its parts after the stage', () => {
    expect(names.service('atlas', 'prod', 'ais')).toBe('atlas--prod--ais');
    expect(names.serviceLogGroup('atlas', 'pr-3', 'ais')).toBe('/platform/apps/atlas/pr-3/services/ais');
    const longest = names.serviceImageTag(
      'a'.repeat(30),
      'b'.repeat(20),
      'c'.repeat(20),
      `d${'e'.repeat(26)}`,
    );
    expect(longest.length).toBeLessThanOrEqual(128);
    expect(names.serviceStopSchedule('ais')).toBe('ais--stop');
  });
});
