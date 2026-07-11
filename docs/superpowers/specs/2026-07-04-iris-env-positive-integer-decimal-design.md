# Iris Environment Positive Integer Decimal Design

## Context

Iris reads environment variables for request timeouts, worker intervals, worker batch sizes, and
embedding dimensions. These settings affect external I/O, queue consumption, and model/index
shape. They should be boring and unambiguous.

The current positive-integer readers use JavaScript `Number()` conversion. That accepts forms such
as `1e3`, `0x10`, and `10.0`. These values can be valid JavaScript numbers but are not clear
operator-facing configuration syntax.

## Decision

Positive integer environment settings are accepted only as non-empty decimal digit strings.

This applies to both required-with-default and optional positive integer environment readers:

- model and embedding request timeouts;
- optional embedding dimensions;
- raw event, document sync, and reindex worker intervals and batch limits;
- Feishu document fetch timeout.

## Scope

This does not change API query parsing, JSON request body numeric parsing, direct dependency
injection guards, queue payload parsing, or already-validated runtime constructor inputs.

## Acceptance Criteria

- Decimal strings such as `1500`, `1536`, and `10` continue to parse.
- Scientific notation such as `1e3` is rejected.
- Hexadecimal notation such as `0x600` is rejected.
- Decimal-point notation such as `10.0` is rejected.
- Existing zero, negative, fractional, and unsafe-integer rejections remain unchanged.
