/**
 * Container compute (ECS on Fargate): the sizes a container may have and
 * what one costs while it runs. Shared by the manifest schema, the engine,
 * the console's cost page and `plat deploy`.
 */

/** vCPUs a Fargate task may have (the platform caps it at 4). */
export const FARGATE_CPUS = [0.25, 0.5, 1, 2, 4] as const;
export type FargateCpu = (typeof FARGATE_CPUS)[number];

/** Memory (MB) Fargate allows for each vCPU size. */
export function fargateMemoryOptions(cpu: FargateCpu): number[] {
  if (cpu === 0.25) return [512, 1024, 2048];
  const [from, to] = MEMORY_RANGES[cpu];
  return Array.from({ length: (to - from) / 1024 + 1 }, (_, i) => from + i * 1024);
}

/** Above 0.25 vCPU, memory goes from..to in steps of 1024 MB. */
const MEMORY_RANGES: Record<Exclude<FargateCpu, 0.25>, readonly [number, number]> = {
  0.5: [1024, 4096],
  1: [2048, 8192],
  2: [4096, 16384],
  4: [8192, 30720],
};

/** Why `cpu`/`memoryMb` isn't a size Fargate runs, or null when it is. */
export function fargateSizeIssue(cpu: number, memoryMb: number): string | null {
  if (!(FARGATE_CPUS as readonly number[]).includes(cpu)) {
    return `cpu must be one of ${FARGATE_CPUS.join(', ')}`;
  }
  const options = fargateMemoryOptions(cpu as FargateCpu);
  if (options.includes(memoryMb)) return null;
  const allowed =
    cpu === 0.25 ? options.join(', ') : `${options[0]}-${options[options.length - 1]} in steps of 1024`;
  return `memoryMb ${memoryMb} doesn't fit ${cpu} vCPU: use ${allowed}`;
}

/** ECS task-definition units: 1024 per vCPU. */
export function fargateCpuUnits(cpu: number): number {
  return Math.round(cpu * 1024);
}

/**
 * Prices behind the estimates: us-east-1, Linux on ARM (Graviton), checked
 * 2026-11-15. Spot prices move with supply and demand, so Spot estimates are
 * approximate. Every task gets a public IPv4 address (there is no NAT), which
 * AWS bills by the hour whatever the capacity.
 */
export const CONTAINER_PRICES_USD = {
  onDemand: { vcpuHour: 0.03238, gbHour: 0.00356 },
  spot: { vcpuHour: 0.00995, gbHour: 0.00109 },
  publicIpv4Hour: 0.005,
} as const;

/** Hours AWS bills a month of always-on capacity for. */
export const HOURS_PER_MONTH = 730;

export interface ContainerCostEstimate {
  /** vCPU and memory, per month. */
  computeUsd: number;
  /** The task's public IPv4 address, per month. */
  publicIpv4Usd: number;
  totalUsd: number;
}

/** What one container of this size costs a month if it runs all the time. */
export function estimateContainerCost(size: {
  cpu: number;
  memoryMb: number;
  spot: boolean;
}): ContainerCostEstimate {
  const price = size.spot ? CONTAINER_PRICES_USD.spot : CONTAINER_PRICES_USD.onDemand;
  const hourly = size.cpu * price.vcpuHour + (size.memoryMb / 1024) * price.gbHour;
  const computeUsd = round2(hourly * HOURS_PER_MONTH);
  const publicIpv4Usd = round2(CONTAINER_PRICES_USD.publicIpv4Hour * HOURS_PER_MONTH);
  return { computeUsd, publicIpv4Usd, totalUsd: round2(computeUsd + publicIpv4Usd) };
}

/** `0.25 vCPU · 512 MB · Spot`. */
export function describeContainerSize(size: { cpu: number; memoryMb: number; spot: boolean }): string {
  return `${size.cpu} vCPU · ${size.memoryMb} MB · ${size.spot ? 'Spot' : 'on-demand'}`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
