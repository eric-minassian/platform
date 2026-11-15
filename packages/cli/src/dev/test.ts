import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { EMULATOR_INSTALL_HINT } from '@ericminassian/platform-engine';
import { withLocalBin } from '../build.ts';
import { loadProject } from '../project.ts';
import { CliError, step, success } from '../util/output.ts';
import { localEnv, startLocalStage } from './local-stage.ts';
import { type Dispatcher, type LocalWorker, startLocalWorker, startWorkerDispatch } from './worker.ts';

export const INTEGRATION_CONFIG = 'vitest.integration.config.ts';

/**
 * `plat test`: a throwaway emulator with this app's resources (stage `test`),
 * then vitest with the same environment the deployed code gets. Uses
 * `vitest.integration.config.ts` when present.
 */
export async function runTests(opts: { cwd: string; args: string[] }): Promise<number> {
  const { root, manifest } = await loadProject(opts.cwd);
  step('starting the AWS Emulator');
  let stage: Awaited<ReturnType<typeof startLocalStage>>;
  try {
    stage = await startLocalStage({ root, manifest, stage: 'test', port: 3999 });
  } catch (err) {
    if ((err as Error).message === EMULATOR_INSTALL_HINT)
      throw new CliError('the AWS Emulator is not installed', { hint: EMULATOR_INSTALL_HINT });
    throw err;
  }
  success(`provisioned ${manifest.name} (stage test)`);
  let worker: LocalWorker | undefined;
  let dispatcher: Dispatcher | undefined;
  try {
    if (manifest.worker) {
      worker = await startLocalWorker(stage, manifest, root, { watch: false });
      worker.child.stdout?.pipe(process.stdout);
      worker.child.stderr?.pipe(process.stderr);
      dispatcher = await startWorkerDispatch(stage, manifest, worker);
    }
    const args = ['run'];
    if (existsSync(join(root, INTEGRATION_CONFIG)) && !opts.args.includes('--config'))
      args.push('--config', INTEGRATION_CONFIG);
    args.push(...opts.args);
    return await new Promise<number>((resolve, reject) => {
      const child = spawn('vitest', args, {
        cwd: root,
        stdio: 'inherit',
        shell: process.platform === 'win32',
        env: withLocalBin(
          root,
          localEnv(stage, manifest, {
            PLATFORM_TEST: '1',
            ...(worker ? { PLATFORM_LOCAL_WORKER_URL: `http://127.0.0.1:${worker.port}/` } : {}),
          }),
        ),
      });
      child.once('exit', (code) => resolve(code ?? 1));
      child.once('error', (err) =>
        reject(
          new CliError(`could not run vitest: ${err.message}`, { hint: 'add vitest to devDependencies' }),
        ),
      );
    });
  } finally {
    dispatcher?.stop();
    worker?.stop();
    await stage.stop();
  }
}
