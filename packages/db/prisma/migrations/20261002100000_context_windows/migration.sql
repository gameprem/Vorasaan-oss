-- Context budgets from the model (ticket 0060, ADR 0012): each Approved Model's
-- context window. Existing models get the window of a known model id (the same
-- table as KNOWN_CONTEXT_WINDOWS in packages/shared/src/ai-settings.ts), else
-- the default of 32,000 tokens; an Admin can edit it in Settings → AI models.

-- AlterTable
ALTER TABLE "ApprovedModel" ADD COLUMN "contextWindow" INTEGER NOT NULL DEFAULT 32000;

UPDATE "ApprovedModel" SET "contextWindow" = CASE
  WHEN "modelId" ~ '^claude-(opus|sonnet|fable|mythos)-(5|4-[6-9])' THEN 1000000
  WHEN "modelId" ~ '^claude-' THEN 200000
  WHEN "modelId" ~ '^gpt-4\.1' THEN 1047576
  WHEN "modelId" ~ '^gpt-5' THEN 400000
  WHEN "modelId" ~ '^(gpt-4o|gpt-4-turbo)' THEN 128000
  WHEN "modelId" ~ '^o[134](-|$)' THEN 200000
  WHEN "modelId" ~ '^gpt-3\.5-turbo' THEN 16385
  WHEN "modelId" ~ '^gpt-4(-|$)' THEN 8192
  ELSE 32000
END;

ALTER TABLE "ApprovedModel" ALTER COLUMN "contextWindow" DROP DEFAULT;
