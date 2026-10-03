# Design Docs are derived from the approved Spec, per Platform

A Spec says what a Feature must do (ADR 0001), with one section per target Platform (ADR 0009). Before writing code, each Platform's team still writes down how: the API contract and data model for the Back-End, the screens and states for the Front-End and Mobile, the test plan for QA. Today that happens outside Vorasaan, drifts from the Spec, and the coding assistant never sees it.

We add **Design Docs**:

- **One per Feature and target Platform.** Back-End (API contract, data model, sequences, error cases), Front-End (screens and states, API calls, validation), Mobile (as Front-End, plus offline and push), and QA (a test plan and test cases traced to the Spec's acceptance criteria). QA gets a Design Doc of its own, although QA is a check and not a Platform (ADR 0009), because its test plan spans every target Platform.
- **Drafted by the AI from the approved Spec.** The AI drafts them only once the Spec is approved and the Platform's Coverage is complete, so it designs from a settled "what". Each Platform has a template, which a Project can edit.
- **Approved by the Platform's people.** A Tech Lead or a Role Owner of the Platform's Team Roles approves, declines or requests changes (ADR 0013). Approved Design Docs are versioned with diffs, like Specs, and are Markdown (ADR 0002).
- **The Spec stays the source of truth.** When the Spec changes, the Design Docs it affects are marked stale and the AI proposes an update. A Design Doc never changes the Spec. A question found while designing becomes a Decision Request, and its answer reaches the Spec the usual way.
- **Handed to the coding assistant.** `vorasaan run` gives a developer the approved Design Doc of their Platform next to the Spec.

## Rejected

- **Design inside the Spec.** The Spec would grow into a document nobody outside engineering reads, and business people would approve API details they can't judge.
- **One Design Doc per Feature for every Platform.** The Back-End and Mobile teams would approve each other's designs, and one stale part would make the whole document stale.
- **Free-form documents as Attachments.** Nothing would know which Spec Version they follow, so they couldn't be marked stale.
- **Drafting before the Spec is approved.** The design would chase a moving Spec, and every Spec change would redraft it.
