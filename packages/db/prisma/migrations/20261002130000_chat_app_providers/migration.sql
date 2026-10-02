-- Chat apps as Organization integrations (ADR 0011, ticket 0057). In a migration of their
-- own: a new enum value can't be used (the next migration's partial unique index) inside
-- the transaction that adds it.

-- AlterEnum
ALTER TYPE "IntegrationProvider" ADD VALUE 'LINE';
ALTER TYPE "IntegrationProvider" ADD VALUE 'SLACK';
ALTER TYPE "IntegrationProvider" ADD VALUE 'TEAMS';
