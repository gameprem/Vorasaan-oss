'use client';

import type { ReactNode } from 'react';
import {
  Dialog as AriaDialog,
  DialogTrigger,
  Heading,
  Modal,
  ModalOverlay,
} from 'react-aria-components';
import { CloseIcon } from '../icons';
import { Button, type ButtonVariant } from './button';

/**
 * A modal dialog: a button opens it, Escape or Close shuts it, focus stays inside.
 * `children` may be a function of `close`, for a Cancel or a Done button.
 */
export function Dialog({
  trigger,
  triggerVariant = 'secondary',
  title,
  children,
  isOpen,
  onOpenChange,
  role = 'dialog',
}: {
  /** The content of the button that opens it; leave out to open it with `isOpen`. */
  trigger?: ReactNode;
  triggerVariant?: ButtonVariant;
  title: string;
  children: ReactNode | ((close: () => void) => ReactNode);
  isOpen?: boolean;
  onOpenChange?: (isOpen: boolean) => void;
  /** `alertdialog` for a confirmation that interrupts. */
  role?: 'dialog' | 'alertdialog';
}) {
  return (
    <DialogTrigger isOpen={isOpen} onOpenChange={onOpenChange}>
      {trigger !== undefined && <Button variant={triggerVariant}>{trigger}</Button>}
      <ModalOverlay
        isDismissable={role === 'dialog'}
        className="fixed inset-0 z-[60] grid place-items-center bg-[rgba(10,12,24,0.35)] p-4 data-[entering]:animate-[fade-in_150ms_ease-out] data-[exiting]:animate-[fade-in_100ms_ease-in_reverse]"
      >
        <Modal className="w-full max-w-lg rounded-sheet bg-bg text-fg shadow-card outline-none data-[entering]:animate-[pop-in_160ms_ease-out]">
          <AriaDialog role={role} className="relative p-6 outline-none">
            {({ close }) => (
              <>
                <Heading slot="title" className="pr-10 text-lg font-semibold">
                  {title}
                </Heading>
                <Button
                  variant="ghost"
                  aria-label="Close"
                  onPress={close}
                  className="absolute top-4 right-4 size-9 p-0!"
                >
                  <CloseIcon size={16} />
                </Button>
                <div className="mt-3">
                  {typeof children === 'function' ? children(close) : children}
                </div>
              </>
            )}
          </AriaDialog>
        </Modal>
      </ModalOverlay>
    </DialogTrigger>
  );
}
