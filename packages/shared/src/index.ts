import { z } from "zod";

export const RoleEnum = z.enum(["PO", "DESIGNER", "BACKEND", "FRONTEND", "MOBILE", "QA"]);

export const BlockerChoiceSchema = z.object({
  id: z.string(),
  label: z.string(),
  impact: z.string(),
});

export const BlockerPayloadSchema = z.object({
  featureId: z.string(),
  raisedByRole: RoleEnum,
  issueDescription: z.string(),
  suggestedChoices: z.array(BlockerChoiceSchema),
  selectedChoiceId: z.string().optional(),
});

export type BlockerPayload = z.infer<typeof BlockerPayloadSchema>;