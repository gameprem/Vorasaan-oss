import { createApp } from './app.ts';
import { webUrl } from './chat-apps/cards.ts';
import { SecretBox } from './crypto/secret-box.ts';
import { SetupTokenService } from './setup/setup-token.service.ts';

// Fail fast in production: without the key, provider secrets can't be stored or read.
if (process.env.NODE_ENV === 'production') {
  try {
    SecretBox.fromEnv();
  } catch (error) {
    console.error(
      `\n✖ ${(error as Error).message}\n  Add it to .env next to docker-compose.yml, then restart.\n`,
    );
    process.exit(1);
  }
}

const app = await createApp();
const port = Number(process.env.PORT ?? 4000);
await app.listen(port, '0.0.0.0');
console.log(`Vorasaan server listening on http://localhost:${port}`);

// While setup is needed: the one place the Setup Token is ever printed (ticket 0062).
const setupAnnouncement = app.get(SetupTokenService).announcement(webUrl());
if (setupAnnouncement) console.log(setupAnnouncement);
