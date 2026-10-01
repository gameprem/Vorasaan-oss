# Platforms, and coverage checked per Platform

A Feature usually ships on more than one part of the product: a Back-End, a web Front-End, a mobile app, maybe a Flutter app added later. Nothing recorded which of these a Feature targets, so nobody could see that its Spec says nothing about the mobile app, or that no one in the Team can answer for it.

We add **Platforms**:

- **Defined per Project.** Each Project has its own list of Platforms. The list starts from a template: the Organization's default, or one of the built-in templates (Back-End, Front-End, Mobile). People can add a Platform later, such as Flutter, without touching other Projects.
- **Targeted by Features.** A Feature names the Platforms it targets.
- **One Spec section each.** A Feature's Spec gets one section per target Platform, a `##` heading with the Platform's name. The Spec stays plain Markdown (ADR 0002); the convention is only a heading.

**Coverage** shows, for every Feature and each of its target Platforms, whether that Platform is covered or missing, and why. Each Platform chooses which checks count, because teams differ:

- **Spec section:** the Spec has a non-empty section for the Platform.
- **Someone to ask:** someone in the Team holds one of the Platform's Team Roles. For example Back-End maps to BACKEND, and Flutter to MOBILE.
- **No open Blockers:** no open Blocker is about the Platform. This uses the Platform named in the Blocker's text or Choices, and becomes exact if Decision Requests are tagged later.
- **QA ready:** the Platform's Spec section has acceptance criteria or test cases (a `###` heading such as "Acceptance criteria" or "Test cases"), and someone in the Team holds the QA Team Role.

QA is a check, not a Platform. Testing applies to every Platform, so "Flutter is missing QA" is more useful than a separate QA column that can't say which Platform is untested.

A template switches every check on. A Project can switch a check off for one Platform, for example "Someone to ask" for a Platform an outside agency builds.

The AI reads coverage: when it drafts a Spec or a Spec Proposal, it fills or asks about the missing sections, and Grilling asks about Platforms that nothing covers.

## Rejected
- **Free-form tags on Features.** Tags would be quick to add, but nothing could say a Platform is *missing*, because no list exists to compare against.
- **One fixed, built-in list.** Simple, but it doesn't fit a company with Flutter, or one with a separate admin web app.
- **QA as a Platform.** A QA column would show tested or not, but not which Platform still lacks test cases.
- **One Spec per Platform.** That would split one Feature's Decisions and history across documents, which is what ADR 0001 avoids.
