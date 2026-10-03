-- OpenRouter as an AI provider (ticket 0064): a key only, its base URL is fixed. Existing
-- custom endpoints pointing at OpenRouter stay as they are; nothing is migrated.

-- AlterEnum
ALTER TYPE "IntegrationProvider" ADD VALUE 'OPENROUTER';
