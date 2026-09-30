# Mastra runs as a library inside NestJS

Mastra ships its own server, which could have replaced the backend. We embed Mastra as a singleton provider in a NestJS `MastraModule` instead. NestJS gives us Guards for Org/Team Role checks, DI and DTO validation, which the role-heavy routing of Decision Requests needs. Mastra's workflow snapshots live in the same Postgres but in a separate schema from Prisma, so domain data and agent state don't mix.
