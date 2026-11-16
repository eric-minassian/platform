/**
 * @ericminassian/plat — programmatic API of the CLI. The foundation deploy
 * and tests import `buildApp`; everything else is for the `plat` binary.
 */
export { ApiClient, ApiError, apiBaseUrl } from './api.ts';
export {
  type BuildOptions,
  type BuildPart,
  type BuildResult,
  buildApp,
  bundleService,
  bundleWorker,
  validateForBuild,
} from './build.ts';
export { configDir, credentialsPath, loadCredentials, type StoredCredentials } from './credentials.ts';
export {
  type DeployOptions,
  type DeployResult,
  deploy,
  formatServiceCost,
  presignedPostForm,
  type ServiceCost,
  serviceCosts,
  waitForDeployment,
} from './deploy.ts';
export { type LocalStage, localEnv, startLocalStage } from './dev/local-stage.ts';
export { deriveStage, fetchOidcToken, gitInfo, isGitHubActions } from './github.ts';
export { type InitOptions, type InitResult, initApp, TEMPLATE_APP_NAME } from './init.ts';
export { createProgram, main } from './main.ts';
export { findProjectRoot, loadProject, type Project } from './project.ts';
export { CliError, EXIT } from './util/output.ts';
