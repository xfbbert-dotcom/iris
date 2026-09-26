import { z } from "zod";
import type { PdAssessment } from "./contracts.js";
import { inspectPdCalculations } from "./arithmetic.js";

const MAX_REASON_CHARS = 2_000;
const MAX_FIELD_REASON_CHARS = 400;
export const PD_REVIEW_FIELDS = ["issueRef", "observation", "reasoning", "suggestion", "uncertainty", "materialChange"] as const;
const MAX_QUOTE_CHARS = 1_200;
const MAX_NUMBER_RECEIPTS = 8;
const MAX_LABEL_CHARS = 120;
const MAX_VALUE_CHARS = 40;
const MAX_UNIT_CHARS = 30;
const DECIMAL_VALUE_PATTERN = "^-?(0|[1-9][0-9]*)(\\.[0-9]+)?$";

// Quote text is intentionally neither trimmed nor Unicode-normalized.
const quoteSchema = z.string().min(1).max(MAX_QUOTE_CHARS)
  .refine(value => value.trim().length > 0).nullable();
const fieldCheckSchema = z.object({
  supported: z.boolean(),
  reason: z.string().min(1).max(MAX_FIELD_REASON_CHARS).regex(/\S/u),
}).strict();
const fieldChecksSchema = z.object({
  issueRef: fieldCheckSchema,
  observation: fieldCheckSchema,
  reasoning: fieldCheckSchema,
  suggestion: fieldCheckSchema,
  uncertainty: fieldCheckSchema,
  materialChange: fieldCheckSchema,
}).strict();
const scopeReviewSchema = z.object({
  fieldChecks: fieldChecksSchema,
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

const numberRevisionSchema = z.object({
  previousIndex: z.number().int().min(0).max(MAX_NUMBER_RECEIPTS - 1),
  replacementIndex: z.number().int().min(0).max(MAX_NUMBER_RECEIPTS - 1).nullable(),
  reason: z.string().min(1).max(MAX_REASON_CHARS).refine(value => value.trim().length > 0),
  sourceRef: z.string().min(1).max(200),
  sourceQuote: quoteSchema.unwrap(),
}).strict();
const finalScopeReviewSchema = scopeReviewSchema.extend({
  numberRevisions: z.array(numberRevisionSchema).max(MAX_NUMBER_RECEIPTS),
});

export type PdScopeReview = z.infer<typeof scopeReviewSchema> & {
  numberRevisions?: z.infer<typeof numberRevisionSchema>[];
};
export type PdScopeReviewHistory = {
  previousNumbers: PdScopeReview["requiredNumbers"];
  evidence: readonly { ref: string; text: string }[];
};

export function validatePdScopeReview(value: unknown, draftText: string, history?: PdScopeReviewHistory, assessment?: PdAssessment): PdScopeReview {
  const hasHistory = history !== undefined && history.previousNumbers.length > 0;
  const parsed = (hasHistory ? finalScopeReviewSchema : scopeReviewSchema).safeParse(value);
  if (!parsed.success) throw new Error("proactive discussion scope review was invalid");
  const review: PdScopeReview = parsed.data;
  const failures: string[] = [];
  const texts: [string, string][] = [["draft.text", draftText]];
  if (assessment) texts.push(
    ["assessment.issueRef.description", assessment.issueRef?.kind === "new" ? assessment.issueRef.description : ""],
    ["assessment.observation", assessment.observation], ["assessment.reasoning", assessment.reasoning],
    ["assessment.suggestion", assessment.suggestion], ["assessment.materialChange.explanation", assessment.materialChange.explanation],
  );
  // These are program-derived contradictions, not model approvals. Keep original
  // field verdicts visible and route contradictions into the same single repair.
  for (const [path, text] of texts) {
    const wrong = inspectPdCalculations(text).filter(calculation => !calculation.matches);
    if (wrong.length) {
      const first = wrong[0]!;
      failures.push(`本地算术矛盾 ${path}[${first.start}:${first.end}]：原文“${first.quote}”的运算结果不等于所写结果。按原运算方向核算并修正；不能用负数缺口等解释批准原式。本字段共${wrong.length}处；这不验证来源、口径或未来后果。`);
    }
  }
  // Completeness and conjunction are deterministic; the model's semantic
  // verdicts are still fallible. A correct draft cannot waive an assessment defect.
  const failedFields = PD_REVIEW_FIELDS.filter(field => !review.fieldChecks[field].supported);
  if (failedFields.length > 0) {
    failures.push(`判断字段复核未通过：${failedFields.join("、")}；请依据各项理由核对并修正同一问题。`);
  }
  // This proves only the returned quote claims, not that the model listed every
  // necessary number or correctly assessed the meaning of the quoted text.
  const invalidNumbers = review.requiredNumbers.flatMap((number, index) =>
    numberQuoteMatches(draftText, number) ? [] : [{ number, index }]);
  const adviceInvalid = review.adviceQuote === null || !draftText.includes(review.adviceQuote);
  if (draftText.length > MAX_QUOTE_CHARS || adviceInvalid || invalidNumbers.length > 0) {
    failures.push("复核凭据未通过当前草稿原句核对；请核对必要数字和具体建议。");
    for (const { number, index } of invalidNumbers) {
      failures.push(`数字凭据[${index}]“${number.label.slice(0, 40)}”：当前草稿引文未同时支持 ${number.expectedValue} ${number.unit}；核对数值、单位及原句，不得借用来源或改写引文。`);
    }
    if (adviceInvalid) failures.push("建议凭据未对应当前草稿原句；核对 adviceQuote 或补齐实际建议。");
  }
  if (hasHistory && !numberHistoryAccountedFor(review, history)) {
    failures.push("最终复核未完整处理此前数字核对项。");
  }
  if (failures.length === 0) return review;
  // The sole repair must see every known local defect, even if the model
  // already rejected another field. Never promote a model rejection to true.
  const localReason = failures.join("\n");
  if (!review.supported && review.reason.includes(localReason)) return review;
  const reason = review.supported ? localReason : `${localReason}\n模型复核：${review.reason}`;
  const truncation = "…（原复核理由截断；字段判定保留）";
  return { ...review, supported: false,
    reason: reason.length <= MAX_REASON_CHARS ? reason
      : reason.slice(0, MAX_REASON_CHARS - truncation.length) + truncation };
}

function numberHistoryAccountedFor(review: PdScopeReview, history: PdScopeReviewHistory): boolean {
  const revised = new Set<number>();
  for (const revision of review.numberRevisions ?? []) {
    if (revision.previousIndex >= history.previousNumbers.length || revised.has(revision.previousIndex)) return false;
    const sources = history.evidence.filter(source => source.ref === revision.sourceRef);
    if (sources.length !== 1 || !sources[0]!.text.includes(revision.sourceQuote)) return false;
    if (revision.replacementIndex !== null && review.requiredNumbers[revision.replacementIndex] === undefined) return false;
    revised.add(revision.previousIndex);
  }
  // A previous diagnosis is fallible. Revisions must explicitly account for it
  // using current authorized source text, rather than silently dropping it or
  // forcing its value into the draft. Literal support is not semantic proof.
  return history.previousNumbers.every((prior, index) => revised.has(index)
    || review.requiredNumbers.some(current => current.expectedValue === prior.expectedValue && current.unit === prior.unit));
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

export function createPdScopeReviewJsonSchema(draftText: string, history?: PdScopeReviewHistory): Record<string, unknown> {
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
  const hasHistory = history !== undefined && history.previousNumbers.length > 0;
  const sourceRefs = history?.evidence.map(source => source.ref) ?? [];
  return {
    type: "object",
    additionalProperties: false,
    required: ["fieldChecks", "supported", "reason", "requiredNumbers", "adviceQuote", ...(hasHistory ? ["numberRevisions"] : [])],
    properties: {
      fieldChecks: {
        type: "object", additionalProperties: false, required: [...PD_REVIEW_FIELDS],
        properties: Object.fromEntries(PD_REVIEW_FIELDS.map(field => [field, {
          type: "object", additionalProperties: false, required: ["supported", "reason"],
          properties: {
            supported: { type: "boolean" },
            reason: { type: "string", minLength: 1, maxLength: MAX_FIELD_REASON_CHARS, pattern: "\\S" },
          },
        }])),
      },
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
      ...(hasHistory ? { numberRevisions: {
        type: "array", maxItems: MAX_NUMBER_RECEIPTS,
        items: {
          type: "object", additionalProperties: false,
          required: ["previousIndex", "replacementIndex", "reason", "sourceRef", "sourceQuote"],
          properties: {
            previousIndex: { type: "integer", minimum: 0, maximum: history.previousNumbers.length - 1 },
            replacementIndex: { anyOf: [{ type: "integer", minimum: 0, maximum: MAX_NUMBER_RECEIPTS - 1 }, { type: "null" }] },
            reason: { type: "string", minLength: 1, maxLength: MAX_REASON_CHARS },
            sourceRef: { type: "string", minLength: 1, maxLength: 200, ...(sourceRefs.length ? { enum: sourceRefs } : {}) },
            sourceQuote: { type: "string", minLength: 1, maxLength: MAX_QUOTE_CHARS },
          },
        },
      } } : {}),
    },
  };
}
