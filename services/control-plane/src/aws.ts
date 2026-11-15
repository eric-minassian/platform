/**
 * AWS clients, and the boundary every AWS SDK call goes through: a rejected
 * call becomes an `AwsError` carrying the service's error code, which callers
 * either handle (`ConditionalCheckFailedException`, `ResourceNotFoundException`)
 * or turn into a defect.
 */
import { CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import { CostExplorerClient } from '@aws-sdk/client-cost-explorer';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { S3Client } from '@aws-sdk/client-s3';
import { SESv2Client } from '@aws-sdk/client-sesv2';
import { SNSClient } from '@aws-sdk/client-sns';
import { SQSClient } from '@aws-sdk/client-sqs';
import { SSMClient } from '@aws-sdk/client-ssm';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { Context, Data, Effect, Layer, Predicate } from 'effect';

/** A rejected AWS SDK call. `code` is the service's error name, e.g. `ParameterNotFound`. */
export class AwsError extends Data.TaggedError('AwsError')<{
  readonly code: string;
  readonly message: string;
  readonly cause: unknown;
}> {
  /** Matches errors with one of `codes`, for `Effect.catchIf`. */
  static readonly is =
    (...codes: ReadonlyArray<string>) =>
    (error: AwsError): boolean =>
      codes.includes(error.code);
}

/** The `AwsError` for what an AWS SDK call threw or rejected with. */
export const toAwsError = (cause: unknown): AwsError =>
  new AwsError({
    code: Predicate.hasProperty(cause, 'name') ? String(cause.name) : 'Error',
    message: Predicate.hasProperty(cause, 'message') ? String(cause.message) : String(cause),
    cause,
  });

/** Runs one AWS SDK call (`(signal) => client.send(command, { abortSignal: signal })`). */
export const tryAws = <A>(call: (signal: AbortSignal) => Promise<A>): Effect.Effect<A, AwsError> =>
  Effect.tryPromise({ try: call, catch: toAwsError });

/** Clients are created on first use: a Web Function instance only pays for the ones it calls. */
export class Aws extends Context.Service<
  Aws,
  {
    readonly ddb: () => DynamoDBDocumentClient;
    readonly s3: () => S3Client;
    readonly ssm: () => SSMClient;
    readonly lambda: () => LambdaClient;
    readonly sqs: () => SQSClient;
    readonly sns: () => SNSClient;
    readonly logs: () => CloudWatchLogsClient;
    readonly cloudwatch: () => CloudWatchClient;
    readonly sesv2: () => SESv2Client;
    /** Cost Explorer is a global service served from us-east-1. */
    readonly ce: () => CostExplorerClient;
  }
>()('@ericminassian/platform-control-plane/Aws') {
  /** Region from the Lambda environment (`AWS_REGION`). */
  static readonly layer: Layer.Layer<Aws> = Layer.sync(Aws, () => {
    const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1';
    const lazy = <T>(make: () => T): (() => T) => {
      let client: T | undefined;
      return () => {
        client ??= make();
        return client;
      };
    };
    return Aws.of({
      ddb: lazy(() =>
        DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
          marshallOptions: { removeUndefinedValues: true },
        }),
      ),
      s3: lazy(() => new S3Client({ region, forcePathStyle: Boolean(process.env.AWS_ENDPOINT_URL) })),
      ssm: lazy(() => new SSMClient({ region })),
      lambda: lazy(() => new LambdaClient({ region })),
      sqs: lazy(() => new SQSClient({ region })),
      sns: lazy(() => new SNSClient({ region })),
      logs: lazy(() => new CloudWatchLogsClient({ region })),
      cloudwatch: lazy(() => new CloudWatchClient({ region })),
      sesv2: lazy(() => new SESv2Client({ region })),
      ce: lazy(() => new CostExplorerClient({ region: 'us-east-1' })),
    });
  });
}
