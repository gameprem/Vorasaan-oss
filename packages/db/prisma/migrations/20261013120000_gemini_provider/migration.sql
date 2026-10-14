-- Gemini as an AI provider (ticket 0080): a key only, its base URL is fixed. In a
-- migration of its own: a new enum value can't be used in the transaction that adds it.

-- AlterEnum
ALTER TYPE "IntegrationProvider" ADD VALUE 'GEMINI';
