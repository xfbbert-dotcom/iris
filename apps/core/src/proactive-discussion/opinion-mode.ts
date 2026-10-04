export type PdOpinionMode = "legacy" | "source-plan";

export function parsePdOpinionMode(value?: string): PdOpinionMode {
  if (value === undefined || value === "legacy") return "legacy";
  if (value === "source-plan") return "source-plan";
  throw new Error("proactive discussion opinion mode must be legacy or source-plan");
}

/** Selects the output contract only, never a provider, model or permission. */
export function pdOpinionModeOptions(mode: PdOpinionMode): { canonicalOpinion?: true; sourceBoundIdentity?: true; opinionPlan?: true } {
  if (mode === "legacy") return {};
  if (mode === "source-plan") return { canonicalOpinion: true, sourceBoundIdentity: true, opinionPlan: true };
  throw new Error("proactive discussion opinion mode must be legacy or source-plan");
}
