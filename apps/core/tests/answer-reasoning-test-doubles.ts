import { vi } from "vitest";

import type { EvidencePlan } from "../src/agent/evidence-plan.js";
import type { EvidencePlanner } from "../src/model/openai-compatible-evidence-planner.js";
import type { GroundedAnswerRenderer } from "../src/model/openai-compatible-grounded-answer-renderer.js";

export function directTaskPlan(): EvidencePlan {
  return {
    taskMode: "direct_task",
    evidenceState: null,
    premises: [],
    proposedAnswer: null,
    missingInformation: [],
    confidence: null,
  };
}

export function companyFactNonePlan(): EvidencePlan {
  return {
    taskMode: "company_fact",
    evidenceState: "none",
    premises: [],
    proposedAnswer: null,
    missingInformation: ["Grounded company evidence"],
    confidence: "low",
  };
}

export function createCompanyFactReasoningDoubles(): {
  planner: EvidencePlanner;
  renderer: GroundedAnswerRenderer;
} {
  return {
    planner: {
      plan: vi.fn<EvidencePlanner["plan"]>(async () => companyFactNonePlan()),
    },
    renderer: {
      render: vi.fn<GroundedAnswerRenderer["render"]>(async () => ({
        answerText: "The available company evidence is insufficient.",
        evidenceState: "none",
        confidence: "low",
      })),
    },
  };
}

export function createDirectTaskReasoningDoubles(): {
  planner: EvidencePlanner;
  renderer: GroundedAnswerRenderer;
} {
  return {
    planner: {
      plan: vi.fn(async () => directTaskPlan()),
    },
    renderer: {
      render: vi.fn(async () => {
        throw new Error("grounded renderer must not run for a direct task");
      }),
    },
  };
}

export function createDirectTaskReasoningRuntimeDependencies() {
  const { planner, renderer } = createDirectTaskReasoningDoubles();
  return {
    createEvidencePlanner: vi.fn(() => planner),
    createGroundedAnswerRenderer: vi.fn(() => renderer),
  };
}

export function createCompanyFactReasoningRuntimeDependencies() {
  const { planner, renderer } = createCompanyFactReasoningDoubles();
  return {
    createEvidencePlanner: vi.fn(() => planner),
    createGroundedAnswerRenderer: vi.fn(() => renderer),
  };
}
