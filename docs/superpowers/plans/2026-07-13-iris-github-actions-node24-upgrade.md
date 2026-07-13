# Iris GitHub Actions Node 24 Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the Iris GitHub Actions workflow off deprecated Node 20 action runtimes without changing CI behavior.

**Architecture:** Keep the existing two-job workflow and update only the official action major tags. Treat the resulting pull-request run as the semantic integration test for the GitHub-hosted runner environment.

**Tech Stack:** GitHub Actions, Node.js 22, Python 3.12, Docker Compose.

## Global Constraints

- The architecture whitepaper remains unchanged.
- Use `actions/checkout@v7`, `actions/setup-node@v6`, and `actions/setup-python@v6`.
- Do not change runtime language versions, job commands, permissions, triggers, or secrets.
- PR #4 Core and AI Worker jobs must pass without a Node 20 deprecation annotation.

---

### Task 1: Upgrade official action runtimes

**Files:**
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: GitHub-hosted `ubuntu-latest` and the existing workflow inputs.
- Produces: the same Core and AI Worker jobs running current official action majors.

- [ ] **Step 1: Update the three action major tags**

Change both checkout uses to `actions/checkout@v7`, setup-node to `actions/setup-node@v6`, and
setup-python to `actions/setup-python@v6`. Make no other workflow edits.

- [ ] **Step 2: Inspect and validate the local diff**

Run `git diff --check` and inspect `git diff -- .github/workflows/ci.yml`. Expected: exactly four
changed lines because checkout appears in both jobs.

- [ ] **Step 3: Request a read-only review**

Confirm the diff preserves triggers, job permissions, language versions, caching, step order, and
commands. Resolve any concrete finding before publishing.

- [ ] **Step 4: Commit and push**

Commit with `ci: upgrade actions to Node 24 runtimes` and push the current branch.

- [ ] **Step 5: Verify the hosted workflow**

Watch the new PR #4 workflow run to completion. Require both jobs to pass and inspect annotations to
confirm the Node 20 deprecation warning is absent.
