# Iris Prompt Attribute Budget Design

## Goal

Prevent oversized prompt metadata from bloating the final model context through XML attributes.

## Architecture

`assemblePromptContext` already bounds live chat message text and background document body text.
This patch extends the same budget discipline to the attribute fields that are closest to the model:

- Live chat `speaker` attributes are capped at `256` escaped characters.
- Background document `source` attributes are capped at `512` escaped characters.

Attributes are bounded after considering XML escaping, so pathological values such as repeated
quotes or angle brackets cannot expand beyond the prompt budget after formatting.

## Invariants

- Recent live chat remains anchored after background documents.
- Blank speakers, sources, and message/document text are still filtered before formatting.
- Short speaker and source values remain unchanged except for trimming and XML escaping.
- Body text budgets remain unchanged: live chat message text at `2000` characters and background
  document text at `1200` characters.
- XML output remains escaped and well-formed after truncation.

## Out Of Scope

- Changing live chat or background document recall limits.
- Redacting identities, document IDs, or URLs inside metadata.
- Changing model prompt section ordering.
- Adding persistent prompt assembly telemetry.
