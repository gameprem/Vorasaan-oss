import { createHash, createHmac } from 'node:crypto';
import { constantTimeEqual } from './adapters/http.ts';

// What a card's button carries back (ticket 0058): which card, which action and which
// Choice, signed with a key derived from VORASAAN_SECRET_KEY. It names no person: who
// pressed comes only from the chat app's verified user id and its Chat Account. The
// signature only stops forged or edited payloads early; the card row it names is then
// checked against the presser anyway.
//
//   "v1.<card id>.<action>.<choice id or ->.<mac>"   (at most 128 characters, under
//   LINE's 300 for postback data)

export type CardAction =
  /** Pick a Choice. */
  | { kind: 'choice'; choiceId: string }
  /** Ask the Raiser for more info (a QUESTION: OPEN → NEEDS_INFO). */
  | { kind: 'ask' }
  /** Decide with a free-text answer. */
  | { kind: 'own' };

export type ActionToken = { cardId: string; action: CardAction };

const VERSION = 'v1';
const CODE = { choice: 'c', ask: 'a', own: 'o' } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class ActionTokens {
  private readonly key: Buffer;

  constructor(secret: string) {
    // Its own key, so a MAC here can never stand in for anything else made from the secret.
    this.key = createHmac('sha256', createHash('sha256').update(secret).digest())
      .update('vorasaan:chat-card-action:v1')
      .digest();
  }

  static fromEnv(env: Record<string, string | undefined> = process.env): ActionTokens {
    const secret = env.VORASAAN_SECRET_KEY;
    if (!secret) throw new Error('VORASAAN_SECRET_KEY is not set');
    return new ActionTokens(secret);
  }

  private mac(body: string): string {
    return createHmac('sha256', this.key).update(body).digest('base64url').slice(0, 32);
  }

  sign(cardId: string, action: CardAction): string {
    const choice = action.kind === 'choice' ? action.choiceId : '-';
    const body = `${VERSION}.${cardId}.${CODE[action.kind]}.${choice}`;
    return `${body}.${this.mac(body)}`;
  }

  /** The card and action, or null for anything not signed by this server. */
  verify(token: unknown): ActionToken | null {
    if (typeof token !== 'string' || token.length > 200) return null;
    const parts = token.split('.');
    if (parts.length !== 5) return null;
    const [version, cardId, code, choice, mac] = parts as [string, string, string, string, string];
    const body = `${version}.${cardId}.${code}.${choice}`;
    if (!constantTimeEqual(Buffer.from(mac), Buffer.from(this.mac(body)))) return null;
    if (version !== VERSION || !UUID.test(cardId)) return null;
    if (code === CODE.choice && UUID.test(choice)) {
      return { cardId, action: { kind: 'choice', choiceId: choice } };
    }
    if (choice !== '-') return null;
    if (code === CODE.ask) return { cardId, action: { kind: 'ask' } };
    if (code === CODE.own) return { cardId, action: { kind: 'own' } };
    return null;
  }
}
