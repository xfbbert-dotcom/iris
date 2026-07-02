import type { ModelProvider } from "../agent/answer-draft-orchestrator.js";
import type { ModelProviderConfig } from "../config/env.js";

export type OpenAICompatibleModelProviderDependencies = {
  config: ModelProviderConfig;
  fetch?: typeof fetch;
};

type ChatCompletionsResponse = {
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
};

export function createOpenAICompatibleModelProvider({
  config,
  fetch = globalThis.fetch,
}: OpenAICompatibleModelProviderDependencies): ModelProvider {
  return {
    async generateAnswerDraft(input) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

      let response: Response;
      try {
        response = await fetch(`${config.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: config.model,
            messages: [
              {
                role: "system",
                content: [
                  "You are Iris, a company AI assistant.",
                  "Answer only from the provided safe context.",
                  "If the context is insufficient, say what is uncertain.",
                  "Do not reveal or infer denied or unavailable document content.",
                ].join(" "),
              },
              {
                role: "user",
                content: `Question:\n${input.question}\n\nContext:\n${input.promptContext}`,
              },
            ],
            temperature: 0.2,
          }),
          signal: controller.signal,
        });
      } catch (error) {
        if (isAbortError(error)) {
          throw new Error("model provider request timed out");
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }

      const responseBody = await readJsonResponse(response);
      if (!response.ok) {
        throw new Error(
          `model provider request failed with status ${response.status}: ${readErrorMessage(responseBody)}`,
        );
      }

      const answerText = readAnswerContent(responseBody).trim();
      if (answerText.length === 0) {
        throw new Error("model provider response did not include answer content");
      }

      return { answerText };
    },
  };
}

async function readJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error("model provider response was not valid JSON");
  }
}

function readAnswerContent(responseBody: unknown): string {
  if (!isRecord(responseBody)) {
    throw new Error("model provider response did not include answer content");
  }

  const choices = responseBody.choices;
  if (!Array.isArray(choices)) {
    throw new Error("model provider response did not include answer content");
  }

  const firstChoice = choices[0];
  if (!isRecord(firstChoice) || !isRecord(firstChoice.message)) {
    throw new Error("model provider response did not include answer content");
  }

  const content = firstChoice.message.content;
  if (typeof content !== "string") {
    throw new Error("model provider response did not include answer content");
  }

  return content;
}

function readErrorMessage(responseBody: unknown): string {
  if (isRecord(responseBody) && isRecord(responseBody.error)) {
    const message = responseBody.error.message;
    if (typeof message === "string" && message.trim().length > 0) {
      return message.trim();
    }
  }

  return "unknown error";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
