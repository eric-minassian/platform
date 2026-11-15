import type { PlatformConfig, PlatformRuntimeConfig } from '@eric-minassian/platform-core';
import type { Engine, EngineContext } from '@eric-minassian/platform-engine';

/** Values produced by earlier steps and consumed by later ones. */
export interface FoundationState {
  accountId?: string;
  zoneId?: string;
  wildcardCertArn?: string;
  zoneCertArn?: string;
  kvs?: { arn: string; id: string };
  routerFunctionArn?: string;
  sitesOacId?: string;
  cachePolicyId?: string;
  distribution?: { id: string; arn: string; domainName: string };
  userPoolId?: string;
  boundaryPolicyArn?: string;
  controlPlaneRoleArn?: string;
  ciRoleArn?: string;
  alertsTopicArn?: string;
  controlPlaneWorkerArn?: string;
  runtime?: PlatformRuntimeConfig;
}

export interface FoundationContext {
  config: PlatformConfig;
  engine: Engine;
  ctx: EngineContext;
  /** AWS Emulator dry run: steps the emulator can't do are skipped. */
  emulator: boolean;
  /** Absolute path of the repo root. */
  repoRoot: string;
  env: { dnsDelegationRoleArn?: string; alertEmail?: string };
  state: FoundationState;
  log(msg: string): void;
}

export interface Step {
  id: string;
  /** One line for `--plan`. */
  describe(config: PlatformConfig): string;
  /** Skipped under `--emulator` (DNS, certificates, the CloudFront distribution). */
  awsOnly?: boolean;
  run(f: FoundationContext): Promise<void>;
}

/** A step can't finish until a human does something (e.g. add a DNS record in another repo). */
export class BlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlockedError';
  }
}
