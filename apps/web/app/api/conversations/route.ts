import { StartConversationInput } from '@vorasaan/shared';
import { forwardPost } from '@/lib/api-proxy';

// Starts a Conversation with its first message; answers once the AI's reply is stored.
export async function POST(request: Request) {
  return forwardPost(request, '/conversations', StartConversationInput);
}
