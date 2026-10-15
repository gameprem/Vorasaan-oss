-- Ticket 0080: of a call's output tokens, those the model spent thinking (null: not reported).
ALTER TABLE "Receipt" ADD COLUMN "reasoningTokens" INTEGER;
