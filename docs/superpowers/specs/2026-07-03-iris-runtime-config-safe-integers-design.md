# Iris Runtime Config Safe Integers Design

## Context

Iris reads timeout, batch size, and embedding dimension settings from environment variables. JavaScript can represent integers larger than `Number.MAX_SAFE_INTEGER`, but those values are no longer exact. Accepting unsafe integers can silently distort operational settings before they reach timers, queues, or embedding-profile logic.

## Decision

All positive integer environment settings must also be safe JavaScript integers:

- Non-integers, zero, and negative values keep the existing validation error.
- Positive integers larger than `Number.MAX_SAFE_INTEGER` are rejected explicitly.
- The same rule applies to optional positive integer settings such as embedding dimensions.

## Scope

This does not add business-specific upper bounds for worker batch sizes or timeouts. It only rejects numbers that JavaScript cannot represent exactly.

## Quality Bar

Environment config tests must cover unsafe timeout values and unsafe optional embedding dimensions.
