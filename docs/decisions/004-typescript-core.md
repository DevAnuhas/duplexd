# 004: TypeScript core with a language-neutral wire contract

Status: superseded by 010
Date: 2026-09-15

## Context

The core is a WebSocket and WebRTC signaling state machine with a JSON event protocol. Both TypeScript and Python are viable. The provider ships SDKs with Live support in both. Consumers exist in both.

## Decision

The core, transports, server, and console are TypeScript on Node 24 with pnpm workspaces and Turborepo. Python appears only as an example handler, integrating over the remote form of the contract.

## Alternatives

**Python core.** Rejected: the console and WebRTC signaling are naturally TypeScript, splitting the repo across two runtimes doubles toolchain and CI cost, and the remote contract already serves Python consumers without an in-process Python library.

**Both cores.** Rejected: two implementations of a state machine drift, and the contract tests would have to prove equivalence between them rather than conformance to one spec.

## Consequences

Python consumers integrate over HTTP, never in-process. If a Python consumer measures a need for in-process integration, that is a new ADR, not a port.

Toolchain versions are pinned exactly (`.node-version`, `packageManager`) and installs are frozen. The pattern is borrowed from an existing TypeScript monorepo scaffold; the choices are re-verified here rather than inherited.

The OpenAI Node SDK's Live support is assumed from documentation and is unverified until the first adapter commit pins a version and runs a live session.
