import * as p from '@clack/prompts';
import type { AttachmentView } from '@vorasaan/shared';
import type { VorasaanApi } from '../api.ts';
import { UsageError } from './raise-options.ts';
import { collectRepoScan } from './repo-scan.ts';

export type ScanOptions = {
  projectId: string;
  /** The repository directory to scan. */
  dir: string;
  /** Print the summary and send nothing. */
  dryRun: boolean;
  /** Send without the confirmation prompt (the summary is still printed). */
  yes: boolean;
};

export type ScanDeps = {
  /** Loaded only when something is about to be sent, so a dry run needs no sign-in. */
  api: () => Promise<VorasaanApi>;
  confirm: (message: string) => Promise<boolean>;
  print: (text: string) => void;
};

/**
 * `vorasaan scan`: builds a Repo Scan of `dir`, prints it, and sends it to the
 * Project only after the user confirms (or passed `--yes`). Opt-in every time.
 */
export async function runScan(
  options: ScanOptions,
  deps: ScanDeps,
): Promise<AttachmentView | undefined> {
  const scan = await collectRepoScan(options.dir);
  const size = Buffer.byteLength(scan.markdown);
  deps.print(scan.markdown);
  deps.print(
    `── Repo Scan of ${scan.repoName}: ${(size / 1000).toFixed(1)} KB from ${scan.fileCount} files` +
      (scan.truncated.length ? `, ${scan.truncated.length} part(s) truncated` : '') +
      '. No whole source files are included.',
  );

  if (options.dryRun) {
    deps.print('Dry run: nothing was sent.');
    return undefined;
  }
  if (!options.yes) {
    const ok = await deps.confirm(`Send this Repo Scan to Project ${options.projectId}?`);
    if (!ok) {
      deps.print('Nothing was sent.');
      return undefined;
    }
  }

  const api = await deps.api();
  const created = await api.postRepoScan(options.projectId, {
    markdown: scan.markdown,
    repoName: scan.repoName,
    ...(scan.commitSha ? { commitSha: scan.commitSha } : {}),
  });
  deps.print(`Sent. Saved as the Project Attachment "${created.title}".`);
  return created;
}

/** Asks in the terminal; refuses to guess when there is no terminal to ask in. */
export async function confirmInTerminal(message: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    throw new UsageError(
      'Cannot ask for confirmation without a terminal. Check the summary with --dry-run, then pass --yes to send it.',
    );
  }
  const answer = await p.confirm({ message, initialValue: false });
  return answer === true;
}
