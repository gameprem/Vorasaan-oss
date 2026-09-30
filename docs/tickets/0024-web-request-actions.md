---
status: todo
depends-on: [0016, 0017, 0018]
slice: mvp-web
---

# 0024: Web: review, send, Claim, reassign, ask for info, withdraw

## Goal
Every Decision Request action from 0016–0018 is available on the web.

## Scope
- Draft review page:
  - edit, add and remove Choices;
  - confirm the decider role;
  - choose recipients (one Role Owner or all);
  - "send now".
- Request page:
  - Claim;
  - reassign (picker of role holders);
  - ask for more info;
  - the NEEDS_INFO thread with an answer box for the Raiser;
  - withdraw for the Raiser;
  - "decided by C on behalf of A".
- Raise from the web (Feature page → "Raise a Decision Request").

## Acceptance criteria
- [ ] Browser-verified (Playwright): raise on the web → send to all → the second PO claims → asks for info → the Raiser answers → decide → approve.
- [ ] Loading, empty and error states for every new view.
