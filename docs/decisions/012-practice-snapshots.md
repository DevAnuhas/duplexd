# 012: Practice uses immutable snapshots and a platform-owned signed backend

Status: accepted
Date: 2026-09-21

## Context

People configuring an assistant need to test saved or unsaved settings without
contacting their customer webhook, mutating the saved assistant, or giving the
voice layer new authority. Browser mocks would not exercise the real delegated
tool path, while temporarily replacing an assistant's connection would race
integration calls and risk sending synthetic traffic to a customer system.

## Decision

Practice compiles allowed assistant fields and explicitly reviewed sample
results into an immutable, versioned call snapshot. The snapshot records the
assistant revision and an authored configuration digest. A preview never writes
the assistant row, and later edits cannot change an existing snapshot.

Practice tool calls use the existing raw-body HMAC protocol against a
platform-owned endpoint. Each call receives a random encrypted Practice secret;
the endpoint accepts only that call's active, unexpired execution and frozen
tool/sample mapping. Customer URLs and secrets are excluded from the Practice
read and compilation paths. The voice model still receives instructions and
audio only.

Assistant and sample writes use revision compare-and-swap. Incomplete assistant
drafts remain editable; one mode-aware predicate decides whether a configuration
is runnable for Practice or integration.

## Alternatives

- Browser-side sample mocks were rejected because they bypass delegation,
  signing, input validation and transport failure behavior.
- Swapping the saved customer connection during a test was rejected because it
  mutates integration behavior and creates a credential-routing race.
- A second demo runtime was rejected because it would drift from the path the
  product needs to prove.

## Consequences

Practice can be tested without customer connectivity and with deterministic
replay, but sample mappings must be reviewed again when a tool name or input
schema changes. Runtime credentials are stored separately from the authored
digest and may be purged after execution. Admission, provider startup and
browser lifecycle remain separate work; this decision does not enable a call
start surface by itself.
