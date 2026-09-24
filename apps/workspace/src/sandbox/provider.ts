import { PIPECAT_AGENT_NAME } from "@/control/constants"
import {
  readSandboxProviderEnvironment,
  resolveSandboxAgentApiBase,
} from "@/db/env"

import { createPracticeBrowserMediaVerifier } from "./browser-media"
import { createSandboxLifecycle } from "./lifecycle"
import { createPipecatSandboxTransport } from "./pipecat-transport"

/**
 * The one place that turns environment into a Sandbox that can actually
 * dispatch. Everything below it — admission, lifecycle, the transport — takes
 * its provider as an argument and reads no environment at all.
 *
 * ADR 015: execution is enabled by server configuration. ADR 013 and ADR 014
 * said no environment variable may enable it, and that single sentence is what
 * ADR 015 supersedes; the rest of both stands, including the rule that made
 * this module necessary. A deployment without the five variables composes the
 * no-transport lifecycle and answers 503 from every execution-bearing route,
 * which is what any unconfigured deployment does.
 *
 * **Composed per call, not at import.** `next build` must not need a provider
 * configuration, an auth origin or a database, and a memoised instance built
 * from the first request's environment is a subtle way to get the wrong one
 * after a variable changes. Construction is closures and string validation —
 * cheaper by orders of magnitude than the database transaction that follows
 * it — so there is nothing to cache.
 */
export function sandboxLifecycle(): ReturnType<typeof createSandboxLifecycle> {
  const environment = readSandboxProviderEnvironment()

  if (environment === null) {
    return createSandboxLifecycle()
  }

  const binding = {
    organizationId: environment.organizationId,
    serviceId: environment.serviceId,
    deploymentId: environment.deploymentId,
    agentName: PIPECAT_AGENT_NAME,
  }

  // `readSandboxProviderEnvironment` already rejects anything the transport
  // would reject, so reaching the catch means the two validations disagree.
  // Refusing is the safe half of that disagreement: a lifecycle with no
  // transport answers 503, where one built from half-trusted configuration
  // would start sessions it cannot then identify as its own.
  try {
    return createSandboxLifecycle({
      transport: createPipecatSandboxTransport({
        publicApiKey: environment.publicApiKey,
        privateApiKey: environment.privateApiKey,
        binding,
        verifyBrowserMedia: createPracticeBrowserMediaVerifier(),
      }),
      binding,
      apiBase: resolveSandboxAgentApiBase(),
    })
  } catch {
    return createSandboxLifecycle()
  }
}
