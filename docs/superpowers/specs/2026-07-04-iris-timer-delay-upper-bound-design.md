# Iris Timer Delay Upper Bound Design

## Context

Several Iris adapters use `setTimeout()` for external request timeouts. Their shared numeric guard
currently accepts any positive safe integer. Node timers cannot safely represent delays above
`2147483647ms`; larger values can overflow and behave like very short timeouts.

## Decision

Add an upper bound to the shared timeout guard used by external adapters:

- positive safe integer validation remains unchanged;
- values above `2147483647` are rejected with a clear error;
- existing defaults remain far below the cap;
- the current helper is only used for timeout values, so this change does not affect queue limits or
  batch sizes.

Worker loop interval guards are duplicated in loop modules and can be handled separately if needed.
This patch focuses on request timeout paths that already share `readPositiveSafeInteger()`.

## Error Handling

Out-of-range timer delays throw:

`<fieldName> must not exceed 2147483647`

Existing zero, negative, fractional, infinite, NaN, and unsafe integer errors remain unchanged.

## Testing

Add a focused numeric-guard test for the Node timer maximum boundary, then run full verification.
