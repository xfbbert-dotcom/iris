const LONG_ASCII_QUESTION_MARK_RUN = /\?{8,}/u;
const MIN_LOSSY_QUESTION_MARK_DENSITY = 0.2;

export interface SemanticEvidenceIntegrityInput {
  text: unknown;
  marker: string;
  messageId: unknown;
}

export function assertSemanticEvidenceIntegrity(
  input: SemanticEvidenceIntegrityInput,
): asserts input is SemanticEvidenceIntegrityInput & { text: string; messageId: string } {
  const text = requireNonBlankString(input.text, "text");
  const messageId = requireNonBlankString(input.messageId, "messageId");
  if (!text.includes(input.marker)) {
    throw new Error(
      `Semantic evidence ${messageId} no longer contains the requested marker`,
    );
  }

  const codePointLength = Array.from(text).length;
  const questionMarkCount = Array.from(text).filter(
    (character) => character === "?",
  ).length;
  const hasDenseQuestionMarkReplacement =
    LONG_ASCII_QUESTION_MARK_RUN.test(text) &&
    questionMarkCount / codePointLength >= MIN_LOSSY_QUESTION_MARK_DENSITY;
  if (text.includes("\uFFFD") || hasDenseQuestionMarkReplacement) {
    throw new Error(
      `Semantic evidence ${messageId} has suspected lossy text encoding`,
    );
  }
}

function requireNonBlankString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a nonblank string`);
  }
  return value;
}
