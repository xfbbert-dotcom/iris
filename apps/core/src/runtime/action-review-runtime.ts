import type { ActionProposalRepository } from "../action-approvals/action-proposal-repository.js";
import {
  createFeishuReviewOAuthClient,
  type FeishuReviewOAuthClient,
} from "../action-reviews/feishu-review-oauth-client.js";
import {
  createActionReviewSessionCodec,
  type ActionReviewSessionCodec,
} from "../action-reviews/action-review-session.js";
import {
  readActionReviewRuntimeConfig,
  type EnvLike,
} from "../config/env.js";
import type { ActionApprovalRuntime } from "./action-approval-runtime.js";

export type ActionReviewRuntime = {
  repository: ActionProposalRepository;
  codec: ActionReviewSessionCodec;
  oauthClient: FeishuReviewOAuthClient;
  getStatus(): Promise<ActionReviewRuntimeStatus>;
  close(): Promise<void>;
};

export type ActionReviewRuntimeStatus = {
  configured: true;
  running: boolean;
  migration0034Applied: boolean;
};

export type ActionReviewRuntimeDependencies = {
  createSessionCodec?: typeof createActionReviewSessionCodec;
  createOAuthClient?: typeof createFeishuReviewOAuthClient;
  close?: () => Promise<void>;
};

export function createActionReviewRuntime({
  env = process.env,
  actionApprovalRuntime,
  dependencies = {},
}: {
  env?: EnvLike;
  actionApprovalRuntime?: Pick<ActionApprovalRuntime, "repository">;
  dependencies?: ActionReviewRuntimeDependencies;
} = {}): ActionReviewRuntime | undefined {
  const config = readActionReviewRuntimeConfig(env);
  if (!config.enabled) return undefined;
  if (actionApprovalRuntime === undefined) {
    throw new Error("actionApprovalRuntime is required when action reviews are enabled");
  }

  const codec = (dependencies.createSessionCodec ?? createActionReviewSessionCodec)({
    secret: config.sessionSecret,
  });
  const oauthClient = (dependencies.createOAuthClient ?? createFeishuReviewOAuthClient)({
    baseUrl: config.feishuOpenApi.baseUrl,
    authorizeUrl: config.authorizeUrl,
    publicOrigin: config.publicOrigin,
    appId: config.feishuOpenApi.appId,
    appSecret: config.feishuOpenApi.appSecret,
  });
  let closePromise: Promise<void> | undefined;
  let closed = false;

  return {
    repository: actionApprovalRuntime.repository,
    codec,
    oauthClient,
    async getStatus() {
      let migration0034Applied = false;
      try {
        migration0034Applied = await actionApprovalRuntime.repository.hasActionReviewMigration?.() === true;
      } catch {
        migration0034Applied = false;
      }
      return {
        configured: true,
        running: !closed,
        migration0034Applied,
      };
    },
    close() {
      closed = true;
      closePromise ??= dependencies.close?.() ?? Promise.resolve();
      return closePromise;
    },
  };
}
