# Iris JSON Body Budget Design

**Goal:** Keep Feishu callbacks and internal operator APIs from parsing unexpectedly large JSON request bodies.

**Problem:** Core App used a custom JSON parser so Feishu signature verification could receive the raw body, but the app did not express an Iris-specific body budget. A sub-megabyte payload could be parsed and passed into gateway logic even though v1 request schemas are much smaller.

**Decision:** Set the Fastify JSON body limit to `256 KiB` for the Core App. This applies before custom JSON parsing, signature verification, queue enqueueing, or internal API request validation. Normal v1 payloads remain well under the limit: answer draft requests cap the question and live chat messages, Feishu message content is separately capped before message-content parsing, and document registration requests are small.

**Tradeoff:** A future feature that legitimately needs larger direct JSON uploads must use a purpose-built endpoint with its own budget and streaming/storage plan instead of raising the global Core App JSON limit.

**Quality Bar:** Oversized JSON returns HTTP `413` and must not call Feishu verification or enqueue any event.
