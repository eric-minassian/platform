/**
 * Telemetry processor I/O: applies an Aggregation to the telemetry table and
 * alerts on new (or regressed) error groups.
 */
import { PublishCommand } from '@aws-sdk/client-sns';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { Cause, Context, Effect, Layer, Option } from 'effect';
import { Aws, AwsError, tryAws } from '../aws.ts';
import { Settings } from '../config.ts';
import { GitHub } from '../github.ts';
import { Store } from '../store.ts';
import { type Aggregation, type ErrorGroupUpdate, maxFollowUps, rollupUpdateInput } from './aggregate.ts';

/** Where the console shows an error group. */
export function errorGroupUrl(consoleUrl: string, g: Pick<ErrorGroupUpdate, 'app' | 'stage' | 'sk'>): string {
  return `${consoleUrl}/apps/${g.app}/errors?stage=${encodeURIComponent(g.stage)}&fp=${g.sk}`;
}

export class TelemetryWriter extends Context.Service<
  TelemetryWriter,
  {
    /** Writes the rollups and error groups; answers the groups that are new or came back after being resolved. */
    apply(aggregation: Aggregation): Effect.Effect<ReadonlyArray<ErrorGroupUpdate>>;
  }
>()('@ericminassian/platform-control-plane/TelemetryWriter') {
  static readonly layer: Layer.Layer<TelemetryWriter, never, Aws | Settings | Store | GitHub> = Layer.effect(
    TelemetryWriter,
    Effect.gen(function* () {
      const aws = yield* Aws;
      const settings = yield* Settings;
      const store = yield* Store;
      const github = yield* GitHub;

      /** Upserts one group; true when it is new, or was resolved and is reopened. */
      const upsertGroup = Effect.fnUntraced(function* (table: string, g: ErrorGroupUpdate) {
        const res = yield* tryAws(() =>
          aws.ddb().send(
            new UpdateCommand({
              TableName: table,
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
          ),
        );
        if (!res.Attributes) return true;
        if (res.Attributes.status !== 'resolved') return false;
        // A resolved error came back: reopen it and alert again.
        yield* tryAws(() =>
          aws.ddb().send(
            new UpdateCommand({
              TableName: table,
              Key: { pk: g.pk, sk: g.sk },
              UpdateExpression: 'SET #status = :open',
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: { ':open': 'open' },
            }),
          ),
        );
        return true;
      });

      const alert = Effect.fn('TelemetryWriter.alert')(function* (g: ErrorGroupUpdate) {
        const url = errorGroupUrl(settings.consoleUrl, g);
        const text = [
          `${g.name}: ${g.message}`,
          `App: ${g.app} (${g.stage})  Source: ${g.source}${g.sample.route ? `  Route: ${g.sample.route}` : ''}${g.sample.job ? `  Job: ${g.sample.job}` : ''}`,
          `First seen: ${g.firstSeen}`,
          '',
          g.sample.stack ?? '(no stack)',
          '',
          url,
        ].join('\n');

        const { alertsTopicArn } = yield* settings.runtime;
        if (alertsTopicArn) {
          yield* tryAws(() =>
            aws.sns().send(
              new PublishCommand({
                TopicArn: alertsTopicArn,
                Subject: `[platform] ${g.app}/${g.stage}: ${g.name}`.slice(0, 99),
                Message: text,
              }),
            ),
          );
        }

        // Prod errors also become an issue in the app's repo, so an agent can pick them up.
        if (g.stage !== 'prod') return;
        const [ghApp, appRecord] = yield* Effect.all([settings.githubApp, store.getApp(g.app)], {
          concurrency: 'unbounded',
        });
        if (Option.isNone(ghApp) || Option.isNone(appRecord)) return;
        yield* github.openIssue(ghApp.value, appRecord.value.repo, {
          title: `[error] ${g.name}: ${g.message}`.slice(0, 200),
          body: `Reported automatically by the platform.\n\n\`\`\`\n${text}\n\`\`\`\n\nLogs, traces and occurrences: ${url}\n\nInvestigate with \`plat errors ${g.app} --stage ${g.stage}\` and \`plat traces ${g.app} <trace>\`.`,
          labels: ['platform-error'],
        });
      });

      const apply = Effect.fn('TelemetryWriter.apply')(function* (aggregation: Aggregation) {
        const { telemetryTable } = yield* settings.runtime;
        yield* Effect.forEach(
          aggregation.rollups,
          (u) =>
            Effect.gen(function* () {
              const res = yield* tryAws(() =>
                aws.ddb().send(new UpdateCommand(rollupUpdateInput(telemetryTable, u))),
              );
              // A concurrent batch that raised it further already wrote the larger value.
              yield* Effect.forEach(
                maxFollowUps(telemetryTable, u, res.Attributes),
                (input) =>
                  tryAws(() => aws.ddb().send(new UpdateCommand(input))).pipe(
                    Effect.catchIf(AwsError.is('ConditionalCheckFailedException'), () => Effect.void),
                  ),
                { discard: true },
              );
            }),
          { concurrency: 16, discard: true },
        ).pipe(Effect.orDie);

        const fresh = yield* Effect.forEach(aggregation.errors, (g) => upsertGroup(telemetryTable, g), {
          concurrency: 8,
        }).pipe(Effect.orDie);
        const newGroups = aggregation.errors.filter((_, i) => fresh[i]);

        // An alert that fails is logged; the rollups and groups are already written.
        yield* Effect.forEach(
          newGroups,
          (g) =>
            alert(g).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning('error alert failed').pipe(
                  Effect.annotateLogs({ err: String(Cause.squash(cause)) }),
                ),
              ),
            ),
          { concurrency: 4, discard: true },
        );
        return newGroups;
      });

      return TelemetryWriter.of({ apply });
    }),
  );
}
