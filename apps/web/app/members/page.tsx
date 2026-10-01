import { redirect } from 'next/navigation';

// Members moved into Settings (ticket 0045); old links still work.
export default function MembersMoved() {
  redirect('/settings/members');
}
