/**
 * Telemetry processor I/O: applies an Aggregation to the telemetry table and
 * alerts on new (or regressed) error groups.
 */
import { PublishCommand } from '@aws-sdk/client-sns';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { log } from '@eric-minassian/platform';
import { aws } from '../aws.ts';
import { consoleUrl, getGithubApp, getRuntimeConfig } from '../config.ts';
import { openIssue } from '../github.ts';
import { getApp } from '../store.ts';
import { pool } from '../util.ts';
import { type Aggregation, type ErrorGroupUpdate, rollupUpdateInput } from './aggregate.ts';

export async function applyAggregation(agg: Aggregation): Promise<{ newGroups: ErrorGroupUpdate[] }> {
  const { telemetryTable } = await getRuntimeConfig();
  await pool(agg.rollups, 16, async (u) => {
    await aws.ddb().send(new UpdateCommand(rollupUpdateInput(telemetryTable, u)));
  });

  const newGroups: ErrorGroupUpdate[] = [];
  await pool(agg.errors, 8, async (g) => {
    const res = await aws.ddb().send(
      new UpdateCommand({
        TableName: telemetryTable,
        Key: { pk: g.pk, sk: g.sk },
        UpdateExpression:
          'ADD #count :c SET #lastSeen = :ls, #firstSeen = if_not_exists(#firstSeen, :fs), #name = :n, ' +
          '#message = :m, #source = :src, #sample = :sample, #stage = :stage, #app = :app, ' +
          '#status = if_not_exists(#status, :open)',
        ExpressionAttributeNames: {
          '#count': 'count',
          '#lastSeen': 'lastSeen',
          '#firstSeen': 'firstSeen',
          '#name': 'name',
          '#message': 'message',
          '#source': 'source',
          '#sample': 'sample',
          '#stage': 'stage',
          '#app': 'app',
          '#status': 'status',
        },
        ExpressionAttributeValues: {
          ':c': g.count,
          ':ls': g.lastSeen,
          ':fs': g.firstSeen,
          ':n': g.name,
          ':m': g.message,
          ':src': g.source,
          ':sample': g.sample,
          ':stage': g.stage,
          ':app': g.app,
          ':open': 'open',
        },
        ReturnValues: 'ALL_OLD',
      }),
    );
    const old = res.Attributes as { status?: string } | undefined;
    if (!old) newGroups.push(g);
    else if (old.status === 'resolved') {
      // A resolved error came back: reopen it and alert again.
      await aws.ddb().send(
        new UpdateCommand({
          TableName: telemetryTable,
          Key: { pk: g.pk, sk: g.sk },
          UpdateExpression: 'SET #status = :open',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':open': 'open' },
        }),
      );
      newGroups.push(g);
    }
  });

  await pool(newGroups, 4, async (g) => {
    await alertErrorGroup(g).catch((err) => log.warn('error alert failed', { err: String(err) }));
  });
  return { newGroups };
}

export function errorGroupUrl(g: Pick<ErrorGroupUpdate, 'app' | 'stage' | 'sk'>): string {
  return `${consoleUrl()}/apps/${g.app}/errors?stage=${encodeURIComponent(g.stage)}&fp=${g.sk}`;
}

async function alertErrorGroup(g: ErrorGroupUpdate): Promise<void> {
  const url = errorGroupUrl(g);
  const text = [
    `${g.name}: ${g.message}`,
    `App: ${g.app} (${g.stage})  Source: ${g.source}${g.sample.route ? `  Route: ${g.sample.route}` : ''}${g.sample.job ? `  Job: ${g.sample.job}` : ''}`,
    `First seen: ${g.firstSeen}`,
    '',
    g.sample.stack ?? '(no stack)',
    '',
    url,
  ].join('\n');

  const { alertsTopicArn } = await getRuntimeConfig();
  if (alertsTopicArn) {
    await aws.sns().send(
      new PublishCommand({
        TopicArn: alertsTopicArn,
        Subject: `[platform] ${g.app}/${g.stage}: ${g.name}`.slice(0, 99),
        Message: text,
      }),
    );
  }

  // Prod errors also become an issue in the app's repo, so an agent can pick them up.
  if (g.stage !== 'prod') return;
  const [ghApp, appRecord] = await Promise.all([getGithubApp(), getApp(g.app)]);
  if (!ghApp || !appRecord) return;
  await openIssue(ghApp, appRecord.repo, {
    title: `[error] ${g.name}: ${g.message}`.slice(0, 200),
    body: `Reported automatically by the platform.\n\n\`\`\`\n${text}\n\`\`\`\n\nLogs, traces and occurrences: ${url}\n\nInvestigate with \`plat errors ${g.app} --stage ${g.stage}\` and \`plat traces ${g.app} <trace>\`.`,
    labels: ['platform-error'],
  });
}
