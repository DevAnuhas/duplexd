"""Strict runner-input and assistant-config validation."""

from __future__ import annotations

from typing import Annotated, Any, Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

from duplexd_agent.errors import AgentConfigError, RunnerInputError

PositiveSeconds = Annotated[float, Field(gt=0, strict=True)]


class RunnerInput(BaseModel):
    """Call-scoped values supplied by the control API to Pipecat Cloud."""

    model_config = ConfigDict(extra="forbid", strict=True)

    call_id: str = Field(alias="callId")
    api_base: str = Field(alias="apiBase")
    agent_token: str = Field(alias="agentToken")

    @field_validator("call_id", "api_base", "agent_token")
    @classmethod
    def require_non_empty(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("must not be empty")
        return value

    @field_validator("api_base")
    @classmethod
    def require_api_url(cls, value: str) -> str:
        parsed = urlsplit(value)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise ValueError("must be an absolute HTTP URL")
        if parsed.username is not None or parsed.password is not None:
            raise ValueError("must not contain credentials")
        return value.rstrip("/")

    @classmethod
    def from_body(cls, body: object) -> RunnerInput:
        if not isinstance(body, dict):
            raise RunnerInputError("runner body must be an object")
        for key in ("callId", "apiBase", "agentToken"):
            value = body.get(key)
            if not isinstance(value, str) or not value.strip():
                raise RunnerInputError(f"runner field {key} must be a non-empty string")
        try:
            return cls.model_validate(body)
        except ValidationError as error:
            field = _first_error_field(error)
            raise RunnerInputError(f"runner field {field} is invalid") from None


class FunctionDefinition(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    name: str
    description: str
    parameters: dict[str, Any]

    @field_validator("name", "description")
    @classmethod
    def require_text(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("must not be empty")
        return value

    @model_validator(mode="after")
    def require_object_parameters(self) -> FunctionDefinition:
        if self.parameters.get("type") != "object":
            raise ValueError("parameters.type must be object")
        properties = self.parameters.get("properties")
        if not isinstance(properties, dict):
            raise ValueError("parameters.properties must be an object")
        required = self.parameters.get("required", [])
        if not isinstance(required, list) or not all(isinstance(item, str) for item in required):
            raise ValueError("parameters.required must be a string array")
        return self


class ToolDefinition(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    type: Literal["function"]
    function: FunctionDefinition


class AgentConfig(BaseModel):
    """Camel-case wire contract returned by the future P05 config endpoint."""

    model_config = ConfigDict(extra="forbid", strict=True, populate_by_name=True)

    assistant_id: str = Field(alias="assistantId")
    voice: str
    instructions: str
    accent_style: str = Field(alias="accentStyle")
    waiting_behavior: str = Field(alias="waitingBehavior")
    backend_model: str = Field(alias="backendModel")
    backend_instructions: str = Field(alias="backendInstructions")
    server_url: str = Field(alias="serverUrl")
    server_secret: str = Field(alias="serverSecret")
    tools: list[ToolDefinition]
    webhook_timeout_secs: PositiveSeconds = Field(alias="webhookTimeoutSecs")
    function_call_timeout_secs: PositiveSeconds = Field(alias="functionCallTimeoutSecs")
    delegation_timeout_secs: PositiveSeconds = Field(alias="delegationTimeoutSecs")

    @field_validator(
        "assistant_id",
        "voice",
        "instructions",
        "backend_model",
        "backend_instructions",
        "server_url",
        "server_secret",
    )
    @classmethod
    def require_non_empty(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("must not be empty")
        return value

    @field_validator("server_url")
    @classmethod
    def require_webhook_url(cls, value: str) -> str:
        parsed = urlsplit(value)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise ValueError("must be an absolute HTTP URL")
        if parsed.username is not None or parsed.password is not None:
            raise ValueError("must not contain credentials")
        if parsed.fragment:
            raise ValueError("must not contain a fragment")
        return value

    @model_validator(mode="after")
    def require_safe_timeout_order(self) -> AgentConfig:
        if self.webhook_timeout_secs >= self.function_call_timeout_secs:
            raise ValueError("webhookTimeoutSecs must be less than functionCallTimeoutSecs")
        if self.webhook_timeout_secs >= self.delegation_timeout_secs:
            raise ValueError("webhookTimeoutSecs must be less than delegationTimeoutSecs")
        return self

    @classmethod
    def from_response(cls, payload: object) -> AgentConfig:
        try:
            return cls.model_validate(payload)
        except ValidationError as error:
            field = _first_error_field(error)
            raise AgentConfigError(f"assistant config field {field} is invalid") from None


def _first_error_field(error: ValidationError) -> str:
    first = error.errors(include_input=False)[0]
    location = first.get("loc", ("config",))
    if not location:
        return "config"
    return ".".join(str(part) for part in location)
