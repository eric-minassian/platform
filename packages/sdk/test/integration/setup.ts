import { startEmulator } from '@eric-minassian/platform-engine';

/**
 * Starts one AWS Emulator for the run and exports its connection into
 * process.env *before* test workers spawn, so they inherit the endpoint,
 * credentials and NODE_EXTRA_CA_CERTS (read by Node only at startup).
 * Needs the emulator installed, or PLAT_EMULATOR_BIN / PLAT_EMULATOR_ENDPOINT.
 */
export default async function setup() {
  const conn = await startEmulator({ port: 0, idleTimeoutSeconds: 900 });
  for (const k of conn.unsetEnv) delete process.env[k];
  Object.assign(process.env, conn.env);
  return async () => {
    await conn.stop();
  };
}
