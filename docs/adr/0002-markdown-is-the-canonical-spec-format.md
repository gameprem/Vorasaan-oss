# Markdown is the canonical Spec format

The web editor is BlockNote, whose native format is block JSON. We store every Spec Version as Markdown and convert to and from BlockNote when editing. Markdown gives readable diffs for Spec Proposals and is easy for the AI to draft edits in. It is also exactly what AI coding assistants receive via `vorasaan run`. We accept losing rich formatting that doesn't round-trip through Markdown.
