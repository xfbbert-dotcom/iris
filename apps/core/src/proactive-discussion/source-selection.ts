import { z } from "zod";
import { pdCanonicalOpinionPlanFormat, pdCanonicalOpinionPlanSchema, PdOpinionPlanBindingError } from "./opinion-plan.js";

const rangeSchema = z.object({ sourceRef: z.string().min(1).max(200),
  startUnit: z.number().int().nonnegative(), endUnit: z.number().int().nonnegative() }).strict();
const gapShape = { premise: rangeSchema, decision: rangeSchema,
  changeExplanation: pdCanonicalOpinionPlanSchema.options[1].shape.changeExplanation };
const selectionSchema = z.discriminatedUnion("kind", [
  pdCanonicalOpinionPlanSchema.options[0],
  z.object({ kind: z.literal("dependency"), ...gapShape, verificationTarget: rangeSchema }).strict(),
  z.object({ kind: z.literal("inference"), ...gapShape }).strict(),
  pdCanonicalOpinionPlanSchema.options[3],
]);

export type PdOpinionSourceCatalog = readonly { sourceRef: string; units: readonly { id: number; text: string }[] }[];
type Range = z.infer<typeof rangeSchema>;

/** Exhaustive location data only: no role selection, normalization or discarded separators. */
export function buildPdOpinionSourceCatalog(evidence: readonly { ref: string; text: string }[]): PdOpinionSourceCatalog {
  const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
  return evidence.map(source => ({ sourceRef: source.ref,
    units: [...segmenter.segment(source.text)].map((part, id) => ({ id, text: part.segment })) }));
}

/** The catalog is built once by the application from authorized evidence, never accepted from the model. */
export function resolvePdOpinionSourceSelection(value: unknown, catalog: PdOpinionSourceCatalog) {
  const plan = selectionSchema.parse(value);
  if (plan.kind === "no_intervention" || plan.kind === "calculation") return plan;
  const resolve = (range: Range) => {
    const sources = catalog.filter(source => source.sourceRef === range.sourceRef);
    if (sources.length !== 1 || range.startUnit > range.endUnit || range.endUnit >= sources[0]!.units.length) {
      throw new PdOpinionPlanBindingError("opinion plan range is not bound to selected evidence");
    }
    const units = sources[0]!.units.slice(range.startUnit, range.endUnit + 1);
    if (units.some((unit, index) => unit.id !== range.startUnit + index)) {
      throw new PdOpinionPlanBindingError("opinion plan range contains unavailable source units");
    }
    const quote = units.map(unit => unit.text).join("");
    if (!/\S/u.test(quote) || quote.length > 200) {
      throw new PdOpinionPlanBindingError("opinion plan selected quote must contain text within 200 characters");
    }
    return { sourceRef: range.sourceRef, quote };
  };
  const premise = resolve(plan.premise), decision = resolve(plan.decision);
  if (plan.kind === "inference") return { ...plan, premise, decision };
  const verificationTarget = resolve(plan.verificationTarget);
  if (![plan.premise, plan.decision].some(range => range.sourceRef === plan.verificationTarget.sourceRef
    && range.startUnit <= plan.verificationTarget.startUnit && range.endUnit >= plan.verificationTarget.endUnit)) {
    throw new PdOpinionPlanBindingError("opinion plan verification target is outside the selected gap");
  }
  return { ...plan, premise, decision, verificationTarget };
}

/** Reuse the canonical branches so quantity and withdrawal contracts cannot drift. */
export function pdOpinionSelectionFormat(repair = false) {
  const format = pdCanonicalOpinionPlanFormat(repair);
  const range = { type: "object", additionalProperties: false, required: ["sourceRef", "startUnit", "endUnit"],
    properties: { sourceRef: { type: "string", minLength: 1, maxLength: 200 },
      startUnit: { type: "integer", minimum: 0 }, endUnit: { type: "integer", minimum: 0 } } };
  for (const branch of format.json_schema.schema.anyOf as { properties: Record<string, unknown> }[]) {
    for (const field of ["premise", "decision", "verificationTarget"]) {
      if (Object.hasOwn(branch.properties, field)) branch.properties[field] = range;
    }
  }
  return format;
}
