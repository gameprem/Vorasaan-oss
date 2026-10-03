'use client';

import type { ReactNode } from 'react';
import {
  Button as AriaButton,
  DatePicker as AriaDatePicker,
  DateRangePicker as AriaDateRangePicker,
  TimeField as AriaTimeField,
  Calendar,
  CalendarCell,
  CalendarGrid,
  CalendarGridBody,
  CalendarGridHeader,
  CalendarHeaderCell,
  DateInput,
  DateSegment,
  Dialog,
  Group,
  Heading,
  I18nProvider,
  RangeCalendar,
  useLocale,
} from 'react-aria-components';
import { BackIcon, CalendarIcon, ForwardIcon } from '../icons';
import {
  calendarLocale,
  type DateGranularity,
  parseIsoDate,
  parseIsoTime,
  toIsoDate,
  toIsoTime,
} from './date-values';
import {
  FieldDescription,
  FieldErrorText,
  FieldLabel,
  type FieldProps,
  useFieldValue,
  well,
} from './field';
import { PopoverSurface } from './popover';

// Date and time pickers (ticket 0077): locale-aware, with an optional Buddhist-era year
// (2569 for 2026) that Thai follows by default. Values are the strings native inputs
// used, always in the ISO calendar: '2026-03-05', '2026-03-05T09:30', '09:30'.

type DateFieldProps = FieldProps & {
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  /** Show a Buddhist-era year. Unset follows the person's language (Thai shows it). */
  buddhistEra?: boolean;
};

/** Shows its children in the Buddhist or Gregorian calendar, or the locale's own. */
function CalendarSystem({ buddhistEra, children }: { buddhistEra?: boolean; children: ReactNode }) {
  const { locale } = useLocale();
  if (buddhistEra === undefined) return children;
  return <I18nProvider locale={calendarLocale(locale, buddhistEra)}>{children}</I18nProvider>;
}

const segmentClass =
  'kit-quiet-focus rounded-md px-0.5 tabular-nums outline-none data-[focused]:bg-ink data-[focused]:text-on-ink data-[placeholder]:text-fg-soft data-[type=literal]:px-0 data-[type=literal]:text-fg-soft';

function Segments({ slot }: { slot?: 'start' | 'end' }) {
  return (
    <DateInput slot={slot} className="flex min-w-0 flex-wrap items-center">
      {(segment) => <DateSegment segment={segment} className={segmentClass} />}
    </DateInput>
  );
}

function OpenCalendar() {
  return (
    <AriaButton className="ml-auto grid size-7 shrink-0 place-items-center rounded-full text-fg-soft outline-none data-[hovered]:bg-surface-hi data-[focus-visible]:ring-2 data-[focus-visible]:ring-focus">
      <CalendarIcon />
    </AriaButton>
  );
}

const navButton =
  'grid size-8 place-items-center rounded-full text-fg-soft outline-none data-[hovered]:bg-surface data-[focus-visible]:ring-2 data-[focus-visible]:ring-focus';
const cellClass =
  'kit-quiet-focus grid size-9 cursor-default place-items-center rounded-full text-sm outline-none data-[outside-month]:hidden data-[hovered]:bg-surface data-[selected]:bg-ink data-[selected]:font-semibold data-[selected]:text-on-ink data-[focus-visible]:ring-2 data-[focus-visible]:ring-focus data-[disabled]:opacity-30 data-[unavailable]:text-fg-faint data-[unavailable]:line-through';

function MonthGrid() {
  return (
    <>
      <header className="flex items-center justify-between gap-2 pb-2">
        <AriaButton slot="previous" className={navButton}>
          <BackIcon />
        </AriaButton>
        <Heading className="text-sm font-semibold" />
        <AriaButton slot="next" className={navButton}>
          <ForwardIcon />
        </AriaButton>
      </header>
      <CalendarGrid className="border-separate border-spacing-0.5">
        <CalendarGridHeader>
          {(day) => (
            <CalendarHeaderCell className="text-xs font-medium text-fg-soft">
              {day}
            </CalendarHeaderCell>
          )}
        </CalendarGridHeader>
        <CalendarGridBody>
          {(date) => <CalendarCell date={date} className={cellClass} />}
        </CalendarGridBody>
      </CalendarGrid>
    </>
  );
}

/** A day, or a day and time (`granularity="minute"`), typed or picked from a calendar. */
export function DatePicker({
  label,
  description,
  value,
  defaultValue = '',
  onChange,
  name,
  granularity = 'day',
  buddhistEra,
  minValue,
  maxValue,
  isRequired,
  isDisabled,
  className,
  labelClassName,
  'aria-label': ariaLabel,
}: DateFieldProps & { granularity?: DateGranularity; minValue?: string; maxValue?: string }) {
  const [current, setCurrent] = useFieldValue(value, defaultValue, onChange);
  return (
    <CalendarSystem buddhistEra={buddhistEra}>
      <AriaDatePicker
        aria-label={ariaLabel}
        value={parseIsoDate(current, granularity)}
        onChange={(date) => setCurrent(toIsoDate(date))}
        granularity={granularity}
        hourCycle={24}
        shouldForceLeadingZeros
        minValue={parseIsoDate(minValue, granularity) ?? undefined}
        maxValue={parseIsoDate(maxValue, granularity) ?? undefined}
        isRequired={isRequired}
        isDisabled={isDisabled}
        validationBehavior="native"
        className={`block ${className ?? ''}`}
      >
        {label && <FieldLabel className={labelClassName}>{label}</FieldLabel>}
        <Group className={`${well} pr-1.5`}>
          <Segments />
          <OpenCalendar />
        </Group>
        <FieldDescription>{description}</FieldDescription>
        <FieldErrorText />
        {name && <input type="hidden" name={name} value={current} disabled={isDisabled} />}
        <PopoverSurface placement="bottom start">
          <Dialog className="p-2 outline-none">
            <Calendar>
              <MonthGrid />
            </Calendar>
          </Dialog>
        </PopoverSurface>
      </AriaDatePicker>
    </CalendarSystem>
  );
}

export type DateRange = { start: string; end: string };

/** A range of days, such as the Decision Lead Time period. */
export function DateRangePicker({
  label,
  description,
  value,
  defaultValue = { start: '', end: '' },
  onChange,
  name,
  buddhistEra,
  isRequired,
  isDisabled,
  className,
  labelClassName,
  'aria-label': ariaLabel,
}: Omit<FieldProps, 'name'> & {
  value?: DateRange;
  defaultValue?: DateRange;
  onChange?: (value: DateRange) => void;
  /** FormData gets `${name}Start` and `${name}End`. */
  name?: string;
  buddhistEra?: boolean;
}) {
  const [current, setCurrent] = useFieldValue(value, defaultValue, onChange);
  const start = parseIsoDate(current.start);
  const end = parseIsoDate(current.end);
  return (
    <CalendarSystem buddhistEra={buddhistEra}>
      <AriaDateRangePicker
        aria-label={ariaLabel}
        value={start && end ? { start, end } : null}
        onChange={(range) =>
          setCurrent({ start: toIsoDate(range?.start), end: toIsoDate(range?.end) })
        }
        shouldForceLeadingZeros
        isRequired={isRequired}
        isDisabled={isDisabled}
        validationBehavior="native"
        className={`block ${className ?? ''}`}
      >
        {label && <FieldLabel className={labelClassName}>{label}</FieldLabel>}
        <Group className={`${well} pr-1.5`}>
          <Segments slot="start" />
          <span aria-hidden className="px-1 text-fg-soft">
            –
          </span>
          <Segments slot="end" />
          <OpenCalendar />
        </Group>
        <FieldDescription>{description}</FieldDescription>
        <FieldErrorText />
        {name && (
          <>
            <input type="hidden" name={`${name}Start`} value={current.start} />
            <input type="hidden" name={`${name}End`} value={current.end} />
          </>
        )}
        <PopoverSurface placement="bottom start">
          <Dialog className="p-2 outline-none">
            <RangeCalendar>
              <MonthGrid />
            </RangeCalendar>
          </Dialog>
        </PopoverSurface>
      </AriaDateRangePicker>
    </CalendarSystem>
  );
}

/** A time of day on a 24-hour clock, '09:30'. */
export function TimeField({
  label,
  description,
  value,
  defaultValue = '',
  onChange,
  name,
  isRequired,
  isDisabled,
  className,
  labelClassName,
  'aria-label': ariaLabel,
}: Omit<DateFieldProps, 'buddhistEra'>) {
  const [current, setCurrent] = useFieldValue(value, defaultValue, onChange);
  return (
    <AriaTimeField
      aria-label={ariaLabel}
      value={parseIsoTime(current)}
      onChange={(time) => setCurrent(toIsoTime(time))}
      hourCycle={24}
      shouldForceLeadingZeros
      isRequired={isRequired}
      isDisabled={isDisabled}
      validationBehavior="native"
      className={`block ${className ?? ''}`}
    >
      {label && <FieldLabel className={labelClassName}>{label}</FieldLabel>}
      <DateInput className={`${well} w-fit! min-w-28`}>
        {(segment) => <DateSegment segment={segment} className={segmentClass} />}
      </DateInput>
      <FieldDescription>{description}</FieldDescription>
      <FieldErrorText />
      {name && <input type="hidden" name={name} value={current} disabled={isDisabled} />}
    </AriaTimeField>
  );
}
