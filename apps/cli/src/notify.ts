import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';

/**
 * OS desktop notifications, best effort. Text always travels as separate argv entries
 * or environment variables of a fixed script, never through a shell or spliced into a
 * script, so an Inbox Item titled `"; rm -rf ~` stays just text.
 */

export type NotifyCommand = { command: string; args: string[]; env?: Record<string, string> };

const MAX_TITLE = 80;
const MAX_BODY = 200;

/** One line of plain text: no control characters, bounded length. */
export function cleanText(text: string, max: number): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
  const flat = text.replace(/[\u0000-\u001F\u007F-\u009F]+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const notOption = (text: string) => (text.startsWith('-') ? ` ${text}` : text);

/** notify-send bodies may be read as markup by the notification daemon. */
const escapeMarkup = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// AppleScript reads the text from `argv`, so nothing is interpolated into the script.
const OSASCRIPT = [
  '-e',
  'on run argv',
  '-e',
  'display notification (item 2 of argv) with title (item 1 of argv)',
  '-e',
  'end run',
];

// PowerShell reads the text from environment variables and XML-escapes it.
const POWERSHELL_TOAST = [
  '$ErrorActionPreference = "Stop"',
  '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
  '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null',
  '$t = [System.Security.SecurityElement]::Escape($env:VORASAAN_NOTIFY_TITLE)',
  '$b = [System.Security.SecurityElement]::Escape($env:VORASAAN_NOTIFY_BODY)',
  '$x = New-Object Windows.Data.Xml.Dom.XmlDocument',
  '$x.LoadXml("<toast><visual><binding template=`"ToastGeneric`"><text>$t</text><text>$b</text></binding></visual></toast>")',
  '$n = [Windows.UI.Notifications.ToastNotification]::new($x)',
  '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("Vorasaan").Show($n)',
].join('; ');

/** The command that shows a notification on `platform`, or undefined where we have none. */
export function notifyCommand(
  platform: NodeJS.Platform,
  rawTitle: string,
  rawBody: string,
): NotifyCommand | undefined {
  const title = cleanText(rawTitle, MAX_TITLE);
  const body = cleanText(rawBody, MAX_BODY);
  switch (platform) {
    case 'darwin':
      // A leading "-" would be read as an osascript option; a space keeps it an argument.
      return { command: 'osascript', args: [...OSASCRIPT, notOption(title), notOption(body)] };
    case 'linux':
    case 'freebsd':
    case 'openbsd':
      return {
        command: 'notify-send',
        args: ['--app-name=Vorasaan', '--', title, escapeMarkup(body)],
      };
    case 'win32':
      return {
        command: 'powershell.exe',
        args: [
          '-NoProfile',
          '-NonInteractive',
          '-WindowStyle',
          'Hidden',
          '-Command',
          POWERSHELL_TOAST,
        ],
        env: { VORASAAN_NOTIFY_TITLE: title, VORASAAN_NOTIFY_BODY: body },
      };
    default:
      return undefined;
  }
}

export type Notifier = {
  notify: (title: string, body: string) => void;
  /** Why notifications are off, if they are (shown once in the TUI). */
  readonly disabledReason: string | undefined;
};

type Spawn = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => { on(event: 'error', listener: (error: Error) => void): unknown; unref(): void };

export function createNotifier(
  options: {
    enabled?: boolean;
    platform?: NodeJS.Platform;
    isTTY?: boolean;
    spawn?: Spawn;
    env?: NodeJS.ProcessEnv;
  } = {},
): Notifier {
  const {
    enabled = true,
    platform = process.platform,
    isTTY = Boolean(process.stdout.isTTY),
    spawn = nodeSpawn as unknown as Spawn,
    env = process.env,
  } = options;
  let disabledReason: string | undefined;
  if (!enabled) disabledReason = 'OS notifications are off (--no-notify)';
  else if (!isTTY) disabledReason = 'OS notifications need an interactive terminal';
  else if (!notifyCommand(platform, '', '')) disabledReason = `No OS notifications on ${platform}`;

  return {
    get disabledReason() {
      return disabledReason;
    },
    notify(title, body) {
      if (disabledReason) return;
      const cmd = notifyCommand(platform, title, body);
      if (!cmd) return;
      try {
        const child = spawn(cmd.command, cmd.args, {
          shell: false,
          stdio: 'ignore',
          windowsHide: true,
          env: cmd.env ? { ...env, ...cmd.env } : env,
        });
        // A missing notifier (ENOENT) turns notifications off quietly; the TUI keeps going.
        child.on('error', () => {
          disabledReason = `${cmd.command} is not available: OS notifications are off`;
        });
        child.unref();
      } catch {
        disabledReason = `${cmd.command} is not available: OS notifications are off`;
      }
    },
  };
}
