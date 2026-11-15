import { CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import { CostExplorerClient } from '@aws-sdk/client-cost-explorer';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { S3Client } from '@aws-sdk/client-s3';
import { SNSClient } from '@aws-sdk/client-sns';
import { SQSClient } from '@aws-sdk/client-sqs';
import { SSMClient } from '@aws-sdk/client-ssm';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

/** Lazily-created AWS clients. Region comes from the Lambda environment (`AWS_REGION`). */
function lazy<T>(make: () => T): () => T {
  let v: T | undefined;
  return () => {
    v ??= make();
    return v;
  };
}

const region = () => process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1';

export const aws = {
  ddb: lazy(() =>
    DynamoDBDocumentClient.from(new DynamoDBClient({ region: region() }), {
      marshallOptions: { removeUndefinedValues: true },
    }),
  ),
  s3: lazy(() => new S3Client({ region: region(), forcePathStyle: Boolean(process.env.AWS_ENDPOINT_URL) })),
  ssm: lazy(() => new SSMClient({ region: region() })),
  lambda: lazy(() => new LambdaClient({ region: region() })),
  sqs: lazy(() => new SQSClient({ region: region() })),
  sns: lazy(() => new SNSClient({ region: region() })),
  logs: lazy(() => new CloudWatchLogsClient({ region: region() })),
  cloudwatch: lazy(() => new CloudWatchClient({ region: region() })),
  /** Cost Explorer is a global service served from us-east-1. */
  ce: lazy(() => new CostExplorerClient({ region: 'us-east-1' })),
};
