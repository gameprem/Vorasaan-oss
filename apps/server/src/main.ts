import { createApp } from './app.ts';

const app = await createApp();
const port = Number(process.env.PORT ?? 4000);
await app.listen(port, '0.0.0.0');
console.log(`Vorasaan server listening on http://localhost:${port}`);
