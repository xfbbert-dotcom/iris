# Iris Feishu Normalizer Timestamp Design

## Context

The raw Feishu message processor already treats Feishu timestamps as positive
decimal millisecond strings. The standalone Feishu event normalizer still uses
`Number(create_time)`, which accepts scientific notation and other JavaScript
number formats that Feishu does not emit as canonical millisecond timestamps.

## Decision

`normalizeFeishuEvent()` must accept only positive decimal millisecond strings
for message `create_time`:

- decimal digit strings are accepted;
- zero, non-decimal strings, unsafe integers, and invalid dates are rejected as
  missing required fields;
- normal valid message normalization remains unchanged.

## Testing

Add focused normalizer tests for scientific-notation and zero timestamps, then
run the normalizer tests and full verification.
