import { Box, Text, useInput } from 'ink';
import { Component, type ReactNode, useEffect, useState } from 'react';

/** The slice of `items` to render so `selected` stays visible in `height` rows. */
export function visibleWindow(count: number, selected: number, height: number) {
  if (count <= height) return { start: 0, end: count };
  const start = Math.min(Math.max(0, selected - Math.floor(height / 2)), count - height);
  return { start, end: start + height };
}

/** A Coverage chip after a row's label: "✓ Back-End" in green, "! Flutter" in yellow. */
export type Chip = { text: string; color: string };

export type Row = {
  key: string;
  label: string;
  highlight?: boolean;
  header?: string;
  /** Shown after the label, each in its own colour. */
  chips?: Chip[];
};

/** A list with a cursor; navigation is handled by the owner (it knows the view state). */
export function ListView({
  rows,
  selected,
  height,
  empty,
}: {
  rows: Row[];
  selected: number;
  height: number;
  empty: string;
}) {
  if (rows.length === 0) return <Text dimColor>{empty}</Text>;
  const { start, end } = visibleWindow(rows.length, selected, height);
  return (
    <Box flexDirection="column">
      {start > 0 && <Text dimColor> ↑ {start} more</Text>}
      {rows.slice(start, end).map((row, i) => {
        const index = start + i;
        const active = index === selected;
        return (
          <Box key={row.key} flexDirection="column">
            {row.header && (
              <Text bold underline>
                {row.header}
              </Text>
            )}
            <Text
              color={active ? 'cyan' : row.highlight ? 'green' : undefined}
              inverse={active}
              wrap="truncate-end"
            >
              {active ? '›' : ' '} {row.label}
              {row.chips?.map((chip) => (
                <Text key={chip.text} color={chip.color}>
                  {'  '}
                  {chip.text}
                </Text>
              ))}
            </Text>
          </Box>
        );
      })}
      {end < rows.length && <Text dimColor> ↓ {rows.length - end} more</Text>}
    </Box>
  );
}

/** A line of scrollable text, optionally colored (diff lines). */
export type Line = string | { text: string; color?: string; dim?: boolean };

/** Scrollable text (a Spec, a Decision Request, a diff): ↑↓/j/k, PgUp/PgDn/space, g/G. */
export function ScrollText({
  lines,
  height,
  active = true,
}: {
  lines: Line[];
  height: number;
  /** False while a form below it takes the keyboard. */
  active?: boolean;
}) {
  const [top, setTop] = useState(0);
  const maxTop = Math.max(0, lines.length - height);
  useEffect(() => {
    setTop((t) => Math.min(t, maxTop));
  }, [maxTop]);
  useInput(
    (input, key) => {
      const move = (delta: number) => setTop((t) => Math.min(maxTop, Math.max(0, t + delta)));
      if (key.downArrow || input === 'j') move(1);
      else if (key.upArrow || input === 'k') move(-1);
      else if (key.pageDown || input === ' ') move(height);
      else if (key.pageUp || input === 'b') move(-height);
      else if (input === 'g' || key.home) setTop(0);
      else if (input === 'G' || key.end) setTop(maxTop);
    },
    { isActive: active },
  );
  const shown = lines.slice(top, top + height);
  return (
    <Box flexDirection="column">
      {shown.map((line, i) =>
        typeof line === 'string' ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional
          <Text key={top + i}>{line || ' '}</Text>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional
          <Text key={top + i} color={line.color} dimColor={line.dim}>
            {line.text || ' '}
          </Text>
        ),
      )}
      {lines.length > height && (
        <Text dimColor>
          lines {top + 1}-{Math.min(lines.length, top + height)} of {lines.length} · ↑↓ j/k scroll ·
          space/b page · g/G top/bottom
        </Text>
      )}
    </Box>
  );
}

/** A one-line text input: type, Backspace, Enter submits, Esc cancels. */
export function TextInput({
  label,
  hint,
  initial = '',
  onSubmit,
  onCancel,
  validate,
}: {
  label: string;
  hint?: string;
  initial?: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
  validate?: (value: string) => string | undefined;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string>();
  useInput((input, key) => {
    if (key.escape) return onCancel();
    if (key.return) {
      const problem = validate?.(value);
      if (problem) return setError(problem);
      return onSubmit(value);
    }
    if (key.backspace || key.delete) return setValue((v) => v.slice(0, -1));
    if (key.ctrl || key.meta || key.tab || key.upArrow || key.downArrow) return;
    if (input) {
      setError(undefined);
      // Pasted text may carry newlines; the field is one line.
      setValue((v) => v + input.replace(/[\r\n]+/g, ' '));
    }
  });
  return (
    <Box flexDirection="column">
      <Text>
        <Text bold>{label}: </Text>
        {value}
        <Text inverse> </Text>
      </Text>
      {hint && <Text dimColor>{hint}</Text>}
      {error && <Text color="red">{error}</Text>}
    </Box>
  );
}

/** A small menu with its own navigation: ↑↓/j/k, Enter picks, Esc cancels. */
export function Menu<T>({
  title,
  options,
  initial = 0,
  onPick,
  onCancel,
}: {
  title: string;
  options: { value: T; label: string; hint?: string }[];
  initial?: number;
  onPick: (value: T) => void;
  onCancel: () => void;
}) {
  const [selected, setSelected] = useState(Math.min(initial, Math.max(0, options.length - 1)));
  useInput((input, key) => {
    if (key.escape) return onCancel();
    if (key.downArrow || input === 'j') setSelected((i) => Math.min(options.length - 1, i + 1));
    else if (key.upArrow || input === 'k') setSelected((i) => Math.max(0, i - 1));
    else if (key.return) {
      const option = options[selected];
      if (option) onPick(option.value);
    }
  });
  return (
    <Box flexDirection="column">
      <Text bold>{title}</Text>
      {options.map((o, i) => (
        <Text key={o.label} color={i === selected ? 'cyan' : undefined} inverse={i === selected}>
          {i === selected ? '›' : ' '} {o.label}
          {o.hint ? <Text dimColor> ({o.hint})</Text> : null}
        </Text>
      ))}
    </Box>
  );
}

/** A yes/no question for destructive actions: y confirms, anything else cancels. */
export function Confirm({
  question,
  onYes,
  onNo,
}: {
  question: string;
  onYes: () => void;
  onNo: () => void;
}) {
  useInput((input) => {
    if (input === 'y' || input === 'Y') onYes();
    else onNo();
  });
  return (
    <Text color="yellow">
      {question} <Text bold>y</Text>/N
    </Text>
  );
}

/** Shows a render error instead of leaving the terminal in raw mode with a stack trace. */
export class ErrorBoundary extends Component<
  { children: ReactNode; onError?: (error: Error) => void },
  { error?: Error }
> {
  override state: { error?: Error } = {};

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error) {
    this.props.onError?.(error);
  }

  override render() {
    if (this.state.error) {
      return <Text color="red">Something went wrong: {this.state.error.message}</Text>;
    }
    return this.props.children;
  }
}
