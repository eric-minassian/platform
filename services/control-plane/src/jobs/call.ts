/**
 * Run a control-plane worker job synchronously and return its result.
 *
 * Engine operations that write the CloudFront KeyValueStore run in the worker
 * (an Event Function), never in the API (a Web Function): KVS PutKey is
 * SigV4A-signed, and from the Web Function runtime it failed with
 * "Authentication failed" while the same call from the worker succeeds.
 */
import { InvokeCommand } from '@aws-sdk/client-lambda';
import { decodeBindings } from '@ericminassian/platform-core';
import { aws } from '../aws.ts';

export async function callWorker<T>(name: string, payload: unknown): Promise<T> {
  const body = JSON.stringify({ __platform: 'invoke', name, payload });

  // `plat dev` runs the worker as a local process that answers { ok, result | error }.
  const local = process.env.PLATFORM_LOCAL_WORKER_URL;
  if (local) {
    const res = await fetch(local, { method: 'POST', body });
    const reply = (await res.json()) as { ok: boolean; result?: T; error?: { message?: string } };
    if (!reply.ok) throw new Error(reply.error?.message ?? `worker job ${name} failed`);
    return reply.result as T;
  }

  const worker = decodeBindings(process.env.PLATFORM_BINDINGS).worker;
  if (!worker) throw new Error('the control plane has no worker binding');
  const out = await aws.lambda().send(
    new InvokeCommand({
      FunctionName: worker,
      InvocationType: 'RequestResponse',
      Payload: new TextEncoder().encode(body),
    }),
  );
  const text = out.Payload ? new TextDecoder().decode(out.Payload) : 'null';
  if (out.FunctionError) {
    const err = JSON.parse(text) as { errorMessage?: string };
    throw new Error(err.errorMessage ?? `worker job ${name} failed (${out.FunctionError})`);
  }
  return JSON.parse(text) as T;
}
