-- Ticket 0081 (follow-up): whether an OpenRouter model takes a reasoning parameter, read
-- from OpenRouter's model list (`supported_parameters`). Null: not known.

-- AlterTable
ALTER TABLE "ApprovedModel" ADD COLUMN "supportsReasoning" BOOLEAN;
