/** Helpers for driving Ink components in tests without fixed sleeps racing async loads. */

export const KEY = {
  tab: '\t',
  shiftTab: '\u001B[Z',
  down: '\u001B[B',
  up: '\u001B[A',
  enter: '\r',
  escape: '\u001B',
};

export const settle = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until the frame shows `text`, then lets Ink attach the new input handlers. */
export async function waitFor(frame: () => string, text: string, timeout = 5000) {
  const end = Date.now() + timeout;
  while (!frame().includes(text)) {
    if (Date.now() > end) throw new Error(`Timed out waiting for "${text}" in:\n${frame()}`);
    await settle(10);
  }
  await settle();
}

export async function press(stdin: { write: (data: string) => void }, ...keys: string[]) {
  for (const key of keys) {
    stdin.write(key);
    await settle();
  }
}
