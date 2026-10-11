import { type DesignDocSummary, designDocWaitText } from '@vorasaan/shared';
import { ROLE_LABEL } from '@/components/ui';

// What the web app says about a Design Doc (ticket 0069), for server and client components.

/** What a Design Doc's row says under its name. */
export function designDocLine(doc: DesignDocSummary): string {
  const current = doc.current
    ? `v${doc.current.version} follows Spec v${doc.current.specVersion}, approved by ${doc.current.approvedBy.name}.`
    : '';
  switch (doc.state) {
    case 'WAITING':
      return doc.waiting.map((w) => `${designDocWaitText(doc.name, w)}.`).join(' ');
    case 'READY':
      return doc.draftError
        ? `The last draft failed: ${doc.draftError}`
        : 'It can be drafted from the approved Spec.';
    case 'DRAFTING':
      return 'The AI is drafting it from the approved Spec.';
    case 'PROPOSED':
      return `Drafted from Spec v${doc.proposal?.specVersion ?? '?'}; it waits for approval.`;
    case 'APPROVED':
      return current;
    case 'STALE':
      return `${current} The Spec has changed what it covers since${
        doc.proposal
          ? `; an update from Spec v${doc.proposal.specVersion} waits for approval.`
          : '.'
      }`;
  }
}

/** Who approves it, in words: "Tech Lead or Backend". */
export function approversText(doc: DesignDocSummary): string {
  return doc.approverRoles.map((r) => ROLE_LABEL[r]).join(' or ');
}
