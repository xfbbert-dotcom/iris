# Frozen meaning-extraction oracle — not model input

This file is for independent offline semantic gates only. The runner never reads it,
and its text, case names, source documents, fixture examples and expected meanings
must not enter model messages. The model receives only each complete original claim
and the same generic meaning-extraction contract. This is a conversion probe, not a
source-support review, production candidate approval or real-group acceptance.

The frozen originals are in `claim-meaning-v2-20261001.inputs.json`; their extraction
selectors and source-file hashes bind them to checked-in historical failures. No
wording was changed, and no human-written answer alternatives are presented.

## bad-risk

The antecedents are alternative conditions: integration discovers problems OR the
supplier side is delayed. Under the condition, the original asserts inability to
deliver on time as a definite consequence. Preserve the original claim strength;
do not reinterpret it as merely a possible schedule risk just because a conditional
marker or another risk phrase occurs. Preserve risk of breach as risk, not a claim
that breach has already happened. Preserve the trust-damage consequence rather than
silently dropping it. No correctness verdict is requested in this stage.

## healthy-advice

Preserve the complete proposed actions, their sequencing, assessment of actual
progress/risk before communication, and the conditional branch for needing to reply
today. These are proposed actions, not claims of completed testing, an existing
buffer or an already adopted company decision. The recommendation must not become
a factual requirement that the sources already issue the same communication
instructions. Preserve the embedded dependency statement and the request to avoid
absolute wording without turning quoted wording into an endorsed assertion.

## supplier-presupposition

Preserve the full proposal and the open questions. The supplier is presented as an
existing counterparty for the new quotation; it is not proposed as a new possible
counterparty or explicitly hypothetical. Record that referent/relation premise
despite the surrounding recommendation. Negotiability and whether extra budget or
other alternatives are approved remain unanswered questions, not established facts.
Do not silently discard the management decision/alternative-actions portion.

## Gates and stop condition

At most three HTTP requests, one per complete claim in the order above. One model
and one schema/task are fixed for the entire window. No retry, correction call,
additional extraction prompt, human options or model-visible expectations. Stop at
the first execution, structural or independent semantic failure. Do not change this
oracle after observing an answer. `pass` requires the meaning to be preserved across
all substantive content, including unlisted collateral changes or invented facts.

Character coverage and exact anchors prove literal preservation and graph integrity
only. They do not prove semantic coverage or complete implicit-premise discovery.
Three passes would permit a separately designed complete-candidate transfer; they
would not show that the original support reviewer is fixed or permit deployment.

Exact model: qwen3.7-plus. non-thinking; max_tokens 4096. Max 3 HTTP / 24000 reported
tokens checked before the next request / 15 minutes total / 60 seconds per request.
Before every HTTP: exact-model free quota at least 150000 tokens, future expiry,
free-exhaustion-stop enabled and UI observation no older than 60 seconds, bound to
the exact request hash. No paid fallback. Each case waits for an independent gate
bound to SHA256(JSON.stringify(result)) before the next request. abortReason stops
pending quota or semantic waits. This file itself is not approval to run.

V2 changes only the generic relation contract: causation and event endpoints; all semantic expectations above remain unchanged. The manual local graphs are not model inputs. V1 remains FAIL.
