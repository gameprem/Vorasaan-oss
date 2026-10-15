'use client';

import {
  type AttachmentView,
  MAX_CONVERSATION_MESSAGE_CHARS,
  type ReasoningSupport,
} from '@vorasaan/shared';
import { type ReactNode, type Ref, useEffect, useId, useRef, useState } from 'react';
import { addLinkAttachment } from '@/lib/attachment-actions';
import type { AttachmentOwner } from '@/lib/ids';
import { BulbIcon, PlusIcon, SendIcon, StopIcon } from '../icons';

// The composer (ADR 0008): a large rounded field. Enter sends, Shift+Enter starts a new
// line. While the AI writes, Send becomes Stop. "+ Attachment" adds a file or a link to the
// Conversation's Feature or Project through the Attachments API, so the AI can read it.

const MAX_HEIGHT = 220;

export function Composer({
  value,
  onChange,
  onSend,
  replying,
  onStop,
  stopping,
  placeholder,
  attachTo,
  context,
  model,
  thinkDeeper,
  disabled,
  inputRef,
}: {
  value: string;
  onChange: (value: string) => void;
  onSend: (content: string) => void;
  /** The AI is writing a reply: Send becomes Stop. */
  replying: boolean;
  onStop: () => void;
  stopping: boolean;
  placeholder: string;
  /** Where "+ Attachment" adds to; none hides the button. */
  attachTo: AttachmentOwner | null;
  /** What the AI reads here, or the scope picker on a new Conversation. */
  context: ReactNode;
  /** The model menu (ticket 0054), between Attachment and the context. */
  model?: ReactNode;
  /** "Think deeper" (ticket 0081): the next message only, at the HIGH Reasoning Level. */
  thinkDeeper?: { on: boolean; onToggle: (on: boolean) => void; support: ReasoningSupport };
  /** Why sending isn't possible yet (no scope picked), if it isn't. */
  disabled?: string;
  inputRef: Ref<HTMLTextAreaElement>;
}) {
  const local = useRef<HTMLTextAreaElement | null>(null);
  const hintId = useId();
  const content = value.trim();
  const canSend = content.length > 0 && !replying && !disabled;

  // Grows with its text, up to MAX_HEIGHT, then scrolls.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure whenever the text changes
  useEffect(() => {
    const el = local.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [value]);

  const send = () => {
    if (canSend) onSend(content);
  };

  return (
    <form
      className="composer"
      aria-label="Message the AI"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <textarea
        ref={(el) => {
          local.current = el;
          if (typeof inputRef === 'function') inputRef(el);
          else if (inputRef) inputRef.current = el;
        }}
        rows={1}
        aria-label="Message"
        aria-describedby={hintId}
        placeholder={placeholder}
        maxLength={MAX_CONVERSATION_MESSAGE_CHARS}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          // Enter sends; Shift+Enter (or Enter while an IME is composing) is a new line.
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          }
        }}
      />
      <span id={hintId} className="sr-only">
        Enter sends, Shift+Enter starts a new line.
        {disabled ? ` ${disabled}` : ''}
      </span>
      <div className="composer-row">
        {attachTo && <AttachButton owner={attachTo} />}
        {model}
        {thinkDeeper && <ThinkDeeper {...thinkDeeper} />}
        <span className="scope">{context}</span>
        {replying ? (
          <button
            type="button"
            className="send stop"
            aria-label="Stop the reply"
            title="Stop the reply"
            disabled={stopping}
            onClick={onStop}
          >
            <StopIcon />
          </button>
        ) : (
          <button
            type="submit"
            className="send"
            aria-label="Send"
            title={disabled ?? 'Send (Enter)'}
            disabled={!canSend}
          >
            <SendIcon />
          </button>
        )}
      </div>
    </form>
  );
}

/**
 * "Think deeper" (ticket 0081): a toggle for the next message alone, which asks the model to
 * think at the HIGH Reasoning Level. Without a reasoning control on the chat's model it stays
 * focusable but does nothing, and says why.
 */
function ThinkDeeper({
  on,
  onToggle,
  support,
}: {
  on: boolean;
  onToggle: (on: boolean) => void;
  support: ReasoningSupport;
}) {
  const reasonId = useId();
  const off = !support.supported;
  return (
    <>
      <button
        type="button"
        className="chip think"
        aria-pressed={off ? false : on}
        aria-disabled={off || undefined}
        aria-describedby={reasonId}
        title={off ? `Think deeper: ${support.reason ?? 'not available'}` : undefined}
        onClick={() => {
          if (!off) onToggle(!on);
        }}
        aria-label="Think deeper"
      >
        <BulbIcon /> <span className="think-label">Think deeper</span>
      </button>
      <span id={reasonId} className="sr-only">
        {off
          ? `Not available: ${support.reason ?? 'this model has no reasoning control'}.`
          : 'For your next message only: the model thinks longer, which costs more.'}
      </span>
    </>
  );
}

/** "+ Attachment": upload a file, or attach a link, to the Feature or Project. */
function AttachButton({ owner }: { owner: AttachmentOwner }) {
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'menu' | 'link'>('menu');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [link, setLink] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const wrap = useRef<HTMLDivElement>(null);

  const close = (focusButton: boolean) => {
    setOpen(false);
    setMode('menu');
    if (focusButton) button.current?.focus();
  };

  // A click outside closes the menu.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current?.contains(e.target as Node)) return;
      setOpen(false);
      setMode('menu');
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const upload = async (picked: File) => {
    setBusy(true);
    setStatus(null);
    const body = new FormData();
    body.append('file', picked);
    try {
      const res = await fetch(`/api/${owner.kind}/${owner.id}/attachments`, {
        method: 'POST',
        body,
      });
      const data = (await res.json().catch(() => null)) as
        | (AttachmentView & { message?: string })
        | null;
      setStatus(
        res.ok
          ? { tone: 'ok', text: `Attached ${data?.title ?? picked.name}. The AI can read it now.` }
          : { tone: 'error', text: data?.message ?? `The upload failed (${res.status}).` },
      );
    } catch {
      setStatus({ tone: 'error', text: "Can't reach Vorasaan. Try again." });
    }
    setBusy(false);
  };

  const attachLink = async () => {
    setBusy(true);
    setStatus(null);
    const form = new FormData();
    form.set('source', 'URL');
    form.set('ref', link);
    const result = await addLinkAttachment(owner, {}, form);
    setBusy(false);
    if (result.ok) {
      setStatus({ tone: 'ok', text: 'Attached the link. The AI can read it now.' });
      setLink('');
      close(true);
    } else {
      setStatus({ tone: 'error', text: result.error ?? 'Could not attach the link.' });
    }
  };

  return (
    <div className="attach" ref={wrap}>
      <button
        ref={button}
        type="button"
        className="chip"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={menuId}
        disabled={busy}
        onClick={() => (open ? close(false) : setOpen(true))}
      >
        <PlusIcon size={14} /> {busy ? 'Attaching…' : 'Attachment'}
      </button>
      <input
        ref={file}
        type="file"
        hidden
        tabIndex={-1}
        onChange={(e) => {
          const picked = e.target.files?.[0];
          e.target.value = '';
          if (picked) upload(picked);
        }}
      />
      {open && (
        <fieldset
          id={menuId}
          className="attach-menu"
          aria-label="Add an Attachment"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              close(true);
            }
          }}
        >
          {mode === 'menu' ? (
            <>
              <button
                type="button"
                className="opt"
                // biome-ignore lint/a11y/noAutofocus: the first choice of the menu just opened
                autoFocus
                onClick={() => {
                  close(true);
                  file.current?.click();
                }}
              >
                <b>Upload a file</b>
                <small>PDF, Markdown, text or Word, read as a Snapshot</small>
              </button>
              <button type="button" className="opt" onClick={() => setMode('link')}>
                <b>Attach a link</b>
                <small>A web page the AI can read</small>
              </button>
            </>
          ) : (
            <div className="attach-link">
              <label htmlFor={`${menuId}-url`} className="text-sm text-fg-soft">
                Link
              </label>
              <input
                id={`${menuId}-url`}
                type="url"
                className="card-input"
                placeholder="https://"
                value={link}
                // biome-ignore lint/a11y/noAutofocus: the field the user just asked for
                autoFocus
                onChange={(e) => setLink(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    if (link.trim()) attachLink();
                  }
                }}
              />
              <button
                type="button"
                className="btn primary"
                disabled={busy || !link.trim()}
                onClick={attachLink}
              >
                Attach
              </button>
            </div>
          )}
        </fieldset>
      )}
      <span
        role={status?.tone === 'error' ? 'alert' : 'status'}
        className={status ? `attach-status ${status.tone}` : 'sr-only'}
      >
        {status?.text}
      </span>
    </div>
  );
}
