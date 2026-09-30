# Vorasaan, not Confluence, is the source of truth for Specs

Teams already keep product docs in Confluence, so making Confluence canonical was the obvious path. We made Vorasaan's own Spec (with Spec Versions and the Decision Log) the source of truth instead. Confluence, Jira, Figma and files are Attachments whose content is snapshotted for AI context. This keeps every flow working for self-hosters who don't use Atlassian, and it keeps the "AI proposes, human approves" version history under our control. Writing back to Confluence/Jira is a later, one-way export.
