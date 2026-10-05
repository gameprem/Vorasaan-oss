-- Ticket 0051: a Spec Proposal (and the Spec Version it becomes) can be the AI's draft of a
-- Platform's acceptance criteria, when Coverage finds that Platform isn't QA ready.
ALTER TYPE "SpecVersionSource" ADD VALUE 'ACCEPTANCE_CRITERIA';
