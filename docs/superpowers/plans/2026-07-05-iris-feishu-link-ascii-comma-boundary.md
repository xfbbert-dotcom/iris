# Iris Feishu Link ASCII Comma Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this
> plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop Feishu document link extraction at ASCII commas so adjacent chat text is not folded
into document tokens.

**Architecture:** Keep the existing extractor and registrar fan-out model. Change only the URL
matching boundary and focused tests.

**Tech Stack:** TypeScript, Vitest.

---

### Task 1: Failing Extractor Test

**Files:**
- Modify: `apps/core/tests/feishu-document-link-extractor.test.ts`

- [x] **Step 1: Add failing comma-boundary coverage**

Assert that `https://docs.feishu.cn/docx/token,please review` extracts
`https://docs.feishu.cn/docx/token`.

- [x] **Step 2: Verify RED**

Run the focused extractor test and confirm it fails by returning `token,please`.

### Task 2: Extractor Boundary Fix

**Files:**
- Modify: `apps/core/src/documents/feishu-document-link-extractor.ts`

- [x] **Step 1: Stop matching URLs at ASCII commas**

Add comma to the URL terminator character class.

- [x] **Step 2: Verify GREEN**

Run extractor, Feishu message processor, and group visible registrar tests.

### Task 3: Full Verification

- [x] Run `npm run verify`.
