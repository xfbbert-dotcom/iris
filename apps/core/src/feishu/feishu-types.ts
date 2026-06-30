import { z } from "zod";

export const rawFeishuEventSchema = z.object({
  idempotencyKey: z.string().min(1),
  receivedAt: z.date(),
  body: z.unknown()
});

export type RawFeishuEvent = z.infer<typeof rawFeishuEventSchema>;
