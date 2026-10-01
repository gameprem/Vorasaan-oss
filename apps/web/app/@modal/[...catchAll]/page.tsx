// Navigating anywhere else (a link inside Settings, say) closes the modal: on a soft
// navigation a slot keeps its last page unless the new URL matches something in it.
export default function NoModal() {
  return null;
}
