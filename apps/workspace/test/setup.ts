import { loadTestEnvironment } from "./helpers/environment.ts"

/**
 * Runs before each test file, in that file's worker.
 *
 * The global setup loads the environment in the runner process; workers are
 * separate processes and do not inherit that, so it is loaded again here.
 */
loadTestEnvironment()
