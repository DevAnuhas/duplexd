"""Safe exception types for startup and runtime boundaries.

Messages on these exceptions may be logged. They must name the failing field or
operation without embedding config values, credentials, response bodies, or URLs.
"""


class AgentError(Exception):
    """Base class for expected, sanitized agent failures."""


class AgentStartupError(AgentError):
    """The call cannot start safely."""


class RunnerInputError(AgentStartupError):
    """Pipecat Cloud did not provide a valid call-scoped runner body."""


class AgentConfigError(AgentStartupError):
    """The platform returned an invalid assistant configuration."""


class PlatformRequestError(AgentStartupError):
    """The platform config request failed without exposing its response."""


class BackendProbeError(AgentStartupError):
    """The configured backend model failed the required tool-call probe."""
