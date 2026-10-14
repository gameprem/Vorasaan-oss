'use client';

import { useEffect } from 'react';
import { type Shown, setShown } from '@/lib/deleted';

/**
 * Names the Feature or Project a page shows when its path doesn't (a Decision Request, a
 * Conversation), so the page moves away if someone deletes it (ticket 0049). Renders nothing.
 */
export function DeletionWatch({ featureId, projectId }: Shown) {
  useEffect(() => setShown({ featureId, projectId }), [featureId, projectId]);
  return null;
}
