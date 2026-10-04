# Iris Source Plan Pilot Configuration Fix

**Goal:** Forward the existing opinion mode through the shipped pilot Compose into Core.

**Contract:** [Runtime acceptance](../../development/iris-opinion-runtime-20261004.md) defines absent mode as `legacy`, explicit `source-plan` as opt-in, and empty/invalid explicit values as startup errors. Selecting a contract grants no model or speech permission.

**Confirmed defect:** On HEAD `6a54b2d1`, rendering pilot Compose with the process mode set to `source-plan` produces no mode in Core. The environment map omits it, so runtime silently defaults to legacy.

## Bounded change and exit

- [x] Add real Compose-render regression tests in `scripts/pilot-compose.test.mjs` for missing/default mode, explicit selection and preservation of empty/invalid values. Compare model and existing speech/group gates to the default configuration; mode is Core-only.
- [x] Observe the regression fail for the missing environment entry.
- [x] Add `IRIS_PROACTIVE_DISCUSSION_OPINION_MODE: ${IRIS_PROACTIVE_DISCUSSION_OPINION_MODE-legacy}` in `deploy/pilot/docker-compose.yml`. No colon: preserve explicit empty strings for the existing runtime parser to reject.
- [x] Document `legacy` in `.env.pilot.example`; do not enable runtime, policy, groups or speech, or change provider/model.
- [x] Run the complete Compose contract test file and existing focused runtime opinion-mode tests. Render CI Compose with `config --quiet`. The new cases only render config; the existing full file also runs a temporary local Caddy boundary test. No pilot stack or provider call is needed.
- [x] Obtain independent scoped review; record four documentation dispositions, exact config-fix commit and remaining authorization inputs for a single-group pilot. Commit locally only.

This is a confirmed deployment-path fix, not another semantic experiment. Stop after the above gate; no production read, push, deployment, model switch, Feishu send or real-data evaluation is authorized.

Completed in config commit `9bfbf0eb`: regression RED 2/2, full Compose GREEN 36/36, focused Core10/10, config check and independent review passed. [Fix and preflight record](../../development/iris-opinion-pilot-config-20261004.md) contains the four dispositions and a bounded read-only production proposal; that proposal has not been executed.
