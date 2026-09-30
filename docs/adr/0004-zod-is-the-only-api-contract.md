# Zod schemas are the only API contract; no class-validator DTOs

NestJS projects conventionally define request/response DTOs as class-validator classes. We define every contract once as a Zod schema in `packages/shared`, and NestJS 12 validates it directly through Standard Schema. The web app and CLI import the same schemas and inferred types. Keeping class-validator DTOs alongside Zod would mean two definitions of every shape that drift apart. We also skip `nestjs-zod`, which doesn't support NestJS 12, because native Standard Schema support makes an adapter unnecessary.
