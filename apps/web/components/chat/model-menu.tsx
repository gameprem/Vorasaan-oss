'use client';

import type { AiModelView } from '@vorasaan/shared';
import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDownIcon } from '../icons';

// The composer's model menu (ticket 0054, ADR 0010): the Approved Models with their
// notes, the current one ticked. Picking one applies from the next message. With a
// single Approved Model there is nothing to pick, so only its name shows.
//
// It is an ARIA menu button: Enter, Space or ArrowDown/ArrowUp open it on the
// current (or the first/last) model; the arrow keys, Home and End move; Enter or Space
// picks; Esc or Tab closes; focus returns to the button.

export function ModelMenu({
  models,
  currentId,
  onPick,
}: {
  models: AiModelView[];
  /** The model the next reply runs on; null when the server picks it (an env override). */
  currentId: string | null;
  onPick: (id: string) => void;
}) {
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const current = models.find((m) => m.id === currentId) ?? null;
  const label = current?.displayName ?? 'Server default';

  // A click outside closes the menu.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  if (models.length === 0) return null;
  if (models.length === 1) {
    return (
      <span className="model-one" title={models[0]?.note ?? undefined}>
        <span className="sr-only">Model: </span>
        {models[0]?.displayName}
      </span>
    );
  }

  const focusItem = (i: number) => {
    const n = models.length;
    items.current[((i % n) + n) % n]?.focus();
  };
  const openAt = (where: 'current' | 'first' | 'last') => {
    setOpen(true);
    const index =
      where === 'first'
        ? 0
        : where === 'last'
          ? models.length - 1
          : Math.max(
              0,
              models.findIndex((m) => m.id === currentId),
            );
    requestAnimationFrame(() => focusItem(index));
  };
  const close = (focusButton: boolean) => {
    setOpen(false);
    if (focusButton) button.current?.focus();
  };
  const pick = (id: string) => {
    onPick(id);
    close(true);
  };

  return (
    <div className="model" ref={wrap}>
      <button
        ref={button}
        type="button"
        className="model-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`Model: ${label}`}
        onClick={() => (open ? close(false) : openAt('current'))}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            openAt(open ? 'first' : 'current');
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            openAt('last');
          }
        }}
      >
        <span className="model-name">{label}</span>
        <ChevronDownIcon />
      </button>
      {open && (
        <div
          id={menuId}
          className="model-menu"
          role="menu"
          aria-label="Models your Admin approved"
          onKeyDown={(e) => {
            const i = items.current.indexOf(document.activeElement as HTMLButtonElement);
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              focusItem(i + 1);
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              focusItem(i - 1);
            } else if (e.key === 'Home') {
              e.preventDefault();
              focusItem(0);
            } else if (e.key === 'End') {
              e.preventDefault();
              focusItem(models.length - 1);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              close(true);
            } else if (e.key === 'Tab') {
              close(false);
            }
          }}
        >
          <div className="h" aria-hidden>
            Models your Admin approved
          </div>
          {models.map((m, i) => (
            <button
              key={m.id}
              ref={(el) => {
                items.current[i] = el;
              }}
              type="button"
              className="opt"
              role="menuitemradio"
              aria-checked={m.id === currentId}
              tabIndex={-1}
              onClick={() => pick(m.id)}
            >
              <b>{m.displayName}</b>
              {(m.note || m.isDefault) && (
                <small>
                  {[m.note, m.isDefault ? 'default' : null].filter(Boolean).join(' · ')}
                </small>
              )}
              <span className="tick" aria-hidden>
                ✓
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
