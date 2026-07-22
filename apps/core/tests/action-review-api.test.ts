import { createHash } from "node:crypto";

import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import type { ActionReviewContext } from "../src/action-approvals/action-proposal-repository.js";
import { registerActionReviewApi } from "../src/action-reviews/action-review-api.js";
import { createActionReviewSessionCodec } from "../src/action-reviews/action-review-session.js";
import type { ActionReviewRuntime } from "../src/runtime/action-review-runtime.js";

const now = () => new Date("2026-07-22T08:00:00.000Z");

describe("action review API", () => {
  it("starts OAuth without reading Postgres, then exchanges once and attests the live context", async () => {
    const fixture = createFixture();
    const app = Fastify();
    registerActionReviewApi(app, fixture.runtime, { now });

    const start = await app.inject({ method: "GET", url: "/review/action-proposals/proposal-1" });
    expect(start.statusCode).toBe(302);
    expect(start.headers["set-cookie"]).toContain("__Host-iris_review_oauth=");
    expect(fixture.repository.getAuthorizedReviewContext).not.toHaveBeenCalled();

    const authorizationUrl = new URL(start.headers.location ?? "");
    const callback = await app.inject({
      method: "GET",
      url: `/review/oauth/callback?state=${encodeURIComponent(authorizationUrl.searchParams.get("state") ?? "")}&code=code-1`,
      headers: { cookie: cookieHeader(start.headers["set-cookie"]) },
    });
    expect(callback.statusCode).toBe(303);
    expect(callback.headers.location).toBe("/review/action-proposals/proposal-1");
    const callbackCookies = Array.isArray(callback.headers["set-cookie"])
      ? callback.headers["set-cookie"].join("\n")
      : callback.headers["set-cookie"] ?? "";
    expect(callbackCookies).toContain("__Host-iris_review_oauth=; ");
    expect(callbackCookies).toContain("__Host-iris_review_session=");
    expect(fixture.oauthClient.exchangeCode).toHaveBeenCalledOnce();
    expect(fixture.repository.getAuthorizedReviewContext).toHaveBeenCalledWith({
      proposalId: "proposal-1",
      actorOpenId: "ou_owner",
    });

    const review = await app.inject({
      method: "GET",
      url: "/review/action-proposals/proposal-1",
      headers: { cookie: cookieHeader(callback.headers["set-cookie"], "__Host-iris_review_session") },
    });
    expect(review.statusCode).toBe(200);
    expect(review.headers["cache-control"]).toBe("no-store");
    expect(fixture.repository.getAuthorizedReviewContext).toHaveBeenCalledTimes(2);

    const sessionValue = cookieValue(callback.headers["set-cookie"], "__Host-iris_review_session");
    const session = fixture.codec.readReviewSession(sessionValue, "proposal-1");
    const attest = await app.inject({
      method: "POST",
      url: "/review/action-proposals/proposal-1/attest",
      headers: {
        cookie: cookieHeader(callback.headers["set-cookie"], "__Host-iris_review_session"),
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: `csrfToken=${encodeURIComponent(session?.csrfToken ?? "")}`,
    });
    expect(attest.statusCode).toBe(200);
    expect(fixture.repository.recordReviewAttestation).toHaveBeenCalledWith(expect.objectContaining({
      proposalId: "proposal-1",
      actorOpenId: "ou_owner",
      expectedContentHash: fixture.context.contentHash,
      sessionIdHash: createHash("sha256").update(session?.sessionId ?? "").digest("hex"),
    }));
    await app.close();
  });

  it("clears failed OAuth transactions and never exchanges a wrong, denied, missing, or replayed callback", async () => {
    const fixture = createFixture();
    const app = Fastify();
    registerActionReviewApi(app, fixture.runtime, { now });
    const start = await app.inject({ method: "GET", url: "/review/action-proposals/proposal-1" });
    const cookie = cookieHeader(start.headers["set-cookie"]);

    for (const url of [
      "/review/oauth/callback?state=wrong&code=code-1",
      "/review/oauth/callback?state=wrong&error=access_denied",
      "/review/oauth/callback?state=wrong",
    ]) {
      const response = await app.inject({ method: "GET", url, headers: { cookie } });
      expect(response.statusCode).toBe(403);
      expect(response.headers["set-cookie"]).toContain("__Host-iris_review_oauth=; ");
      expect(response.body).toContain("审阅不可用");
      expect(response.body).not.toContain("wrong");
    }
    expect(fixture.oauthClient.exchangeCode).not.toHaveBeenCalled();

    const authorizationUrl = new URL(start.headers.location ?? "");
    const callbackUrl = `/review/oauth/callback?state=${encodeURIComponent(authorizationUrl.searchParams.get("state") ?? "")}&code=code-1`;
    const success = await app.inject({ method: "GET", url: callbackUrl, headers: { cookie } });
    expect(success.statusCode).toBe(303);
    const replay = await app.inject({ method: "GET", url: callbackUrl, headers: { cookie: cookieHeader(success.headers["set-cookie"]) } });
    expect(replay.statusCode).toBe(403);
    expect(fixture.oauthClient.exchangeCode).toHaveBeenCalledOnce();
    await app.close();
  });

  it("fails closed for wrong sessions, CSRF, unauthorized live context, stale context, and malformed form bodies", async () => {
    const fixture = createFixture();
    const app = Fastify();
    registerActionReviewApi(app, fixture.runtime, { now });
    app.post("/unrelated", async () => ({ ok: true }));
    const session = fixture.codec.createReviewSession({ proposalId: "proposal-1", actorOpenId: "ou_owner" });
    const sessionCookie = `__Host-iris_review_session=${session.cookieValue}`;

    const wrongProposal = await app.inject({
      method: "GET",
      url: "/review/action-proposals/proposal-2",
      headers: { cookie: sessionCookie },
    });
    expect(wrongProposal.statusCode).toBe(302);
    expect(fixture.repository.getAuthorizedReviewContext).not.toHaveBeenCalled();

    const csrf = await app.inject({
      method: "POST",
      url: "/review/action-proposals/proposal-1/attest",
      headers: { cookie: sessionCookie, "content-type": "application/x-www-form-urlencoded" },
      payload: "csrfToken=wrong",
    });
    expect(csrf.statusCode).toBe(403);
    expect(fixture.repository.recordReviewAttestation).not.toHaveBeenCalled();

    fixture.repository.getAuthorizedReviewContext.mockResolvedValueOnce(undefined);
    const unauthorized = await app.inject({
      method: "GET",
      url: "/review/action-proposals/proposal-1",
      headers: { cookie: sessionCookie },
    });
    expect(unauthorized.statusCode).toBe(403);
    expect(unauthorized.body).toContain("审阅不可用");

    const malformed = await app.inject({
      method: "POST",
      url: "/review/action-proposals/proposal-1/attest",
      headers: { cookie: sessionCookie, "content-type": "application/x-www-form-urlencoded" },
      payload: "csrfToken=one&csrfToken=two",
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.body).toContain("审阅不可用");
    const unrelated = await app.inject({
      method: "POST",
      url: "/unrelated",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "csrfToken=anything",
    });
    expect(unrelated.statusCode).toBe(415);
    await app.close();
  });

  it("does not expose any review route when the runtime is absent", async () => {
    const app = Fastify();
    registerActionReviewApi(app, undefined, { now });
    expect((await app.inject({ method: "GET", url: "/review/action-proposals/proposal-1" })).statusCode).toBe(404);
    await app.close();
  });
});

function createFixture() {
  const context: ActionReviewContext = {
    proposalId: "proposal-1",
    proposalVersion: 7,
    draftId: "draft-1",
    subjectRevision: 3,
    subjectVersion: 11,
    title: "Pilot SOP",
    content: "Full draft body",
    contentHash: "a".repeat(64),
    riskLevel: "medium",
    targetDisplayName: "Knowledge base",
    requirements: [{ kind: "designated_owner", state: "pending" }],
  };
  const repository = {
    getAuthorizedReviewContext: vi.fn(async (): Promise<ActionReviewContext | undefined> => context),
    recordReviewAttestation: vi.fn(async () => ({ outcome: "applied" as const })),
  };
  const codec = createActionReviewSessionCodec({ secret: "s".repeat(32), now });
  const oauthClient = {
    buildAuthorizationUrl: vi.fn(({ state, codeChallenge }: { state: string; codeChallenge: string }) => {
      const url = new URL("https://accounts.feishu.cn/open-apis/authen/v1/authorize");
      url.searchParams.set("state", state);
      url.searchParams.set("code_challenge", codeChallenge);
      return url;
    }),
    exchangeCode: vi.fn(async () => ({ actorOpenId: "ou_owner" })),
  };
  return {
    context,
    repository,
    codec,
    oauthClient,
    runtime: { repository, codec, oauthClient, close: vi.fn(async () => undefined) } as unknown as ActionReviewRuntime,
  };
}

function cookieHeader(value: string | string[] | undefined, name?: string): string {
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return values
    .filter((item) => name === undefined || item.startsWith(`${name}=`))
    .map((item) => item.split(";", 1)[0])
    .join("; ");
}

function cookieValue(value: string | string[] | undefined, name: string): string {
  const header = cookieHeader(value, name);
  return header.slice(`${name}=`.length);
}
