import { z } from "zod";

const MAX_REASON_CHARS = 2_000;
const MAX_QUOTE_CHARS = 1_200;
const MAX_NUMBER_RECEIPTS = 8;
const MAX_LABEL_CHARS = 120;
const MAX_VALUE_CHARS = 40;
const MAX_UNIT_CHARS = 30;
const DECIMAL_VALUE_PATTERN = "^-?(0|[1-9][0-9]*)(\\.[0-9]+)?$";

// Quote text is intentionally neither trimmed nor Unicode-normalized.
const quoteSchema = z.string().min(1).max(MAX_QUOTE_CHARS)
  .refine(value => value.trim().length > 0).nullable();
const scopeReviewSchema = z.object({
  supported: z.boolean(),
  reason: z.string().max(MAX_REASON_CHARS)
    .transform(value => value.normalize("NFC").trim())
    .refine(value => value.length > 0),
  requiredNumbers: z.array(z.object({
    label: z.string().min(1).max(MAX_LABEL_CHARS).refine(value => value.trim().length > 0),
    expectedValue: z.string().max(MAX_VALUE_CHARS).regex(new RegExp(DECIMAL_VALUE_PATTERN, "u")),
    unit: z.string().min(1).max(MAX_UNIT_CHARS).refine(value => value === value.trim()),
    draftQuote: quoteSchema,
  }).strict()).max(MAX_NUMBER_RECEIPTS),
  adviceQuote: quoteSchema,
}).strict();

export type PdScopeReview = z.infer<typeof scopeReviewSchema>;

export function validatePdScopeReview(value: unknown, draftText: string): PdScopeReview {
  const parsed = scopeReviewSchema.safeParse(value);
  if (!parsed.success) throw new Error("proactive discussion scope review was invalid");
  const review = parsed.data;
  if (!review.supported) return review;
  // This proves only the returned quote claims, not that the model listed every
  // necessary number or correctly assessed the meaning of the quoted text.
  if (draftText.length > MAX_QUOTE_CHARS || review.adviceQuote === null
    || !draftText.includes(review.adviceQuote)
    || !review.requiredNumbers.every(number => numberQuoteMatches(draftText, number))) {
    return { ...review, supported: false,
      reason: "复核凭据未通过当前草稿原句核对；请核对必要数字和具体建议。" };
  }
  return review;
}

function numberQuoteMatches(draftText: string, number: PdScopeReview["requiredNumbers"][number]): boolean {
  if (number.draftQuote === null) return false;
  // Scan full-draft tokens before quote spans: '6万元' is also a substring of
  // '16万元'. Signed, decimal, grouped and exponential tokens are not converted.
  const tokens = draftText.matchAll(/(?:[+\-−－负]\s*)?\p{Nd}+(?:[.,，．]\p{Nd}+)*(?:[eE][+\-]?\p{Nd}+)?/gu);
  for (const token of tokens) {
    if (token[0] !== number.expectedValue) continue;
    const start = token.index!;
    const numberEnd = start + token[0].length;
    const gap = /^[ \t]*/u.exec(draftText.slice(numberEnd))![0].length;
    const unitStart = numberEnd + gap;
    const end = unitStart + number.unit.length;
    if (!draftText.startsWith(number.unit, unitStart)) continue;
    const quoteStart = draftText.lastIndexOf(number.draftQuote, start);
    if (quoteStart !== -1 && end <= quoteStart + number.draftQuote.length) return true;
  }
  return false;
}

export function createPdScopeReviewJsonSchema(draftText: string): Record<string, unknown> {
  // Every candidate is an unchanged span of this draft, never source or assessment
  // text. The whole draft also permits quoting evidence that crosses a boundary.
  const quoteChoices = [...new Set([
    ...draftText.split(/(?<=[。！？；;\r\n])/u).filter(segment => segment.trim().length > 0),
    draftText,
  ])];
  const quote = { anyOf: [
    { type: "string", minLength: 1, maxLength: MAX_QUOTE_CHARS, enum: quoteChoices },
    { type: "null" },
  ] };
  return {
    type: "object",
    additionalProperties: false,
    required: ["supported", "reason", "requiredNumbers", "adviceQuote"],
    properties: {
      supported: { type: "boolean" },
      reason: { type: "string", minLength: 1, maxLength: MAX_REASON_CHARS },
      requiredNumbers: {
        type: "array", maxItems: MAX_NUMBER_RECEIPTS,
        items: {
          type: "object", additionalProperties: false,
          required: ["label", "expectedValue", "unit", "draftQuote"],
          properties: {
            label: { type: "string", minLength: 1, maxLength: MAX_LABEL_CHARS },
            expectedValue: { type: "string", maxLength: MAX_VALUE_CHARS, pattern: DECIMAL_VALUE_PATTERN },
            unit: { type: "string", minLength: 1, maxLength: MAX_UNIT_CHARS },
            draftQuote: quote,
          },
        },
      },
      adviceQuote: quote,
    },
  };
}
