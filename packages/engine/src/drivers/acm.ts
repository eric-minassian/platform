import {
  DescribeCertificateCommand,
  ListCertificatesCommand,
  RequestCertificateCommand,
} from '@aws-sdk/client-acm';
import { type EngineContext, tagList, waitFor } from '../util.ts';

export interface CertificateState {
  arn: string;
  status: string;
  /** DNS records ACM wants for validation (CNAMEs). */
  validation: Array<{ domain: string; name: string; value: string; status?: string }>;
}

/** A DNS-validated public certificate in us-east-1 (for CloudFront and Cognito custom domains). */
export async function ensureCertificate(
  ctx: EngineContext,
  spec: { domainName: string; alternativeNames?: string[]; tags?: Record<string, string> },
): Promise<CertificateState> {
  const acm = ctx.clients.acm;
  const wantedSans = [...new Set([spec.domainName, ...(spec.alternativeNames ?? [])])].sort();
  let arn: string | undefined;
  let NextToken: string | undefined;
  do {
    const res = await acm.send(
      new ListCertificatesCommand({ CertificateStatuses: ['ISSUED', 'PENDING_VALIDATION'], NextToken }),
    );
    for (const c of res.CertificateSummaryList ?? []) {
      if (c.DomainName !== spec.domainName || !c.CertificateArn) continue;
      const d = await acm.send(new DescribeCertificateCommand({ CertificateArn: c.CertificateArn }));
      const sans = [...(d.Certificate?.SubjectAlternativeNames ?? [])].sort();
      if (JSON.stringify(sans) === JSON.stringify(wantedSans)) {
        arn = c.CertificateArn;
        break;
      }
    }
    NextToken = arn ? undefined : res.NextToken;
  } while (NextToken);

  if (!arn) {
    const res = await acm.send(
      new RequestCertificateCommand({
        DomainName: spec.domainName,
        SubjectAlternativeNames: wantedSans,
        ValidationMethod: 'DNS',
        IdempotencyToken: spec.domainName.replace(/[^A-Za-z0-9]/g, '').slice(0, 32),
        Tags: spec.tags ? tagList(spec.tags) : undefined,
      }),
    );
    arn = res.CertificateArn!;
    ctx.log('info', 'requested certificate', `certificate ${spec.domainName}`);
  }
  return describeCertificate(ctx, arn);
}

export async function describeCertificate(ctx: EngineContext, arn: string): Promise<CertificateState> {
  // Validation records appear a few seconds after the request.
  return waitFor(`certificate ${arn} validation records`, async () => {
    const d = await ctx.clients.acm.send(new DescribeCertificateCommand({ CertificateArn: arn }));
    const cert = d.Certificate!;
    const validation = (cert.DomainValidationOptions ?? [])
      .filter((o) => o.ResourceRecord?.Name)
      .map((o) => ({
        domain: o.DomainName!,
        name: o.ResourceRecord!.Name!,
        value: o.ResourceRecord!.Value!,
        ...(o.ValidationStatus ? { status: o.ValidationStatus } : {}),
      }));
    if (cert.Status === 'PENDING_VALIDATION' && validation.length === 0) return false;
    return { arn, status: cert.Status ?? 'UNKNOWN', validation };
  });
}

export async function waitCertificateIssued(
  ctx: EngineContext,
  arn: string,
  timeoutMs = 15 * 60_000,
): Promise<void> {
  await waitFor(
    `certificate ${arn} issued`,
    async () => {
      const d = await ctx.clients.acm.send(new DescribeCertificateCommand({ CertificateArn: arn }));
      if (d.Certificate?.Status === 'FAILED') throw new Error(`certificate ${arn} failed validation`);
      return d.Certificate?.Status === 'ISSUED';
    },
    { timeoutMs, intervalMs: 10_000 },
  );
}
