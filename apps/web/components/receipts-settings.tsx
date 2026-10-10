'use client';

import { MAX_RECEIPT_RETENTION_DAYS, type ReceiptSettingsView } from '@vorasaan/shared';
import { useId, useState, useTransition } from 'react';
import { type ActionResult, saveReceiptSettings } from '@/lib/ai-settings-actions';
import { field } from './ui';
import { Button, buttonClass } from './ui/button';
import { Switch } from './ui/switch';

// Settings → AI → Receipts (ticket 0070, ADR 0015): whether every AI call leaves a Receipt,
// how long Receipts are kept, how many there are, and their JSONL export.

export const RECEIPTS_EXPORT_URL = '/api/settings/ai/receipts/export';

const numberFormat = new Intl.NumberFormat('en');

export function ReceiptsSettings({ settings }: { settings: ReceiptSettingsView }) {
  const [enabled, setEnabled] = useState(settings.enabled);
  const [days, setDays] = useState(String(settings.retentionDays));
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string }>();
  const daysId = useId();
  const hintId = useId();

  const save = (action: () => Promise<ActionResult>, done: string, undo?: () => void) =>
    start(async () => {
      const result = await action();
      if (result.error) {
        undo?.();
        setMessage({ ok: false, text: result.error });
      } else setMessage({ ok: true, text: done });
    });

  const retention = Number(days);
  const validDays =
    Number.isInteger(retention) && retention >= 1 && retention <= MAX_RECEIPT_RETENTION_DAYS;

  return (
    <section aria-labelledby="ai-receipts">
      <h3 id="ai-receipts" className="text-lg font-semibold">
        Receipts
      </h3>
      <p className="mt-1 text-sm text-fg-soft">
        A Receipt records each AI call: its task, prompt version, model, tokens and time, and what
        people then did with its proposal. Never the prompt or the reply. They are how the Learning
        Loop learns.
      </p>

      <div className="mt-4 space-y-5">
        <Switch
          isSelected={enabled}
          isDisabled={pending}
          onChange={(on) => {
            setEnabled(on);
            setMessage(undefined);
            save(
              () => saveReceiptSettings({ enabled: on }),
              on ? 'Receipts are being kept.' : 'No new Receipts will be kept.',
              () => setEnabled(!on),
            );
          }}
        >
          Keep a Receipt of every AI call
        </Switch>

        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!validDays) return;
            setMessage(undefined);
            save(() => saveReceiptSettings({ retentionDays: retention }), 'Saved.');
          }}
        >
          <div>
            <label htmlFor={daysId} className="text-sm">
              Keep Receipts for (days)
            </label>
            <input
              id={daysId}
              type="number"
              min={1}
              max={MAX_RECEIPT_RETENTION_DAYS}
              required
              aria-describedby={hintId}
              value={days}
              onChange={(e) => {
                setDays(e.target.value);
                setMessage(undefined);
              }}
              className={`${field} w-28`}
            />
          </div>
          <Button
            type="submit"
            variant="secondary"
            isDisabled={pending || !validDays || retention === settings.retentionDays}
          >
            Save
          </Button>
          <p id={hintId} className="w-full text-sm text-fg-soft">
            Older Receipts are deleted once a day, with what people did with them. Turning
            collection off keeps the ones already there until then.
          </p>
        </form>

        <div className="flex flex-wrap items-center gap-4">
          <p data-testid="receipt-count">
            {settings.count === 0
              ? 'No Receipts kept yet.'
              : `${numberFormat.format(settings.count)} Receipt${settings.count === 1 ? '' : 's'} kept${
                  settings.oldestAt
                    ? `, the oldest from ${new Date(settings.oldestAt).toLocaleDateString('en', { dateStyle: 'medium' })}`
                    : ''
                }.`}
          </p>
          <a href={RECEIPTS_EXPORT_URL} download className={buttonClass('secondary', 'sm')}>
            Export (JSONL)
          </a>
        </div>
        <p className="text-sm text-fg-soft">
          The export leaves out people’s names, emails and Attachment contents; people appear as ids
          such as “person-1”. Its format can feed Reef or other tools.
        </p>

        {message && (
          <p
            role={message.ok ? 'status' : 'alert'}
            className={message.ok ? 'text-jade' : 'text-lacquer'}
          >
            {message.text}
          </p>
        )}
      </div>
    </section>
  );
}
