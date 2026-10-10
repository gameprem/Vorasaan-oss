'use client';

import {
  Button as AriaButton,
  UNSTABLE_Toast as AriaToast,
  Text,
  UNSTABLE_ToastContent as ToastContent,
  UNSTABLE_ToastQueue as ToastQueue,
  UNSTABLE_ToastRegion as ToastRegion,
} from 'react-aria-components';
import { CloseIcon } from '../icons';

// Short notices that come and go at the bottom of the screen: "Saved", "Link copied".
// `toast()` from anywhere on the client; <Toaster /> sits once in the root layout.

export type ToastContentValue = {
  title: string;
  description?: string;
  tone?: 'neutral' | 'success' | 'error';
};

const queue = new ToastQueue<ToastContentValue>({ maxVisibleToasts: 3 });

/** Show a toast; it closes itself after `timeout` ms (5 s), or never for an error. */
export function toast(content: ToastContentValue, timeout?: number) {
  return queue.add(content, {
    timeout: timeout ?? (content.tone === 'error' ? undefined : 5000),
  });
}

const TONE = {
  neutral: 'bg-fg text-bg',
  success: 'bg-jade text-on-ink',
  error: 'bg-lacquer text-on-ink',
} as const;

export function Toaster() {
  return (
    <ToastRegion
      queue={queue}
      className="fixed right-4 bottom-4 z-[80] flex flex-col-reverse gap-2 outline-none"
    >
      {({ toast: t }) => (
        <AriaToast
          toast={t}
          className={`flex w-80 max-w-[calc(100vw-2rem)] items-start gap-3 rounded-card px-4 py-3 shadow-card outline-none data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-focus ${
            TONE[t.content.tone ?? 'neutral']
          }`}
        >
          <ToastContent className="min-w-0 flex-1">
            <Text slot="title" className="block font-semibold">
              {t.content.title}
            </Text>
            {t.content.description && (
              <Text slot="description" className="block text-sm opacity-90">
                {t.content.description}
              </Text>
            )}
          </ToastContent>
          <AriaButton
            slot="close"
            className="grid size-7 shrink-0 place-items-center rounded-full outline-none data-[hovered]:bg-black/10 data-[focus-visible]:ring-2 data-[focus-visible]:ring-current"
          >
            <CloseIcon size={14} />
          </AriaButton>
        </AriaToast>
      )}
    </ToastRegion>
  );
}
