# Response Windows, and deciding from LINE, Slack and Teams

Tools like this fail quietly. A Blocker waits for days because the Decider never opened the web app. Two changes go after that.

## Response Windows

Every open Decision Request has a **Response Window**: a Blocker gets 4 working hours and a Question 2 working days by default.
- A Project can change these defaults, and the Raiser can shorten the window when raising.
- Working hours follow the Organization's time zone and working days. Public holidays are a list the Admin maintains.

When the window runs out, an **escalation** runs in steps:
1. Remind the Recipients.
2. Add the active Delegate of each Recipient, if there is one.
3. Tell the Raiser and the Team's Tech Leads that it is overdue, so they can reassign it or decide whether to wait.

An escalation never changes who decides and never decides anything itself. A person still Claims, reassigns or decides; the system only makes the wait visible to the right people. Each step is written to the request's history.

**Decision lead time** is recorded per request: from sent to decided, and how long it waited at each person. A Project sees its median lead time and its overdue requests.

## Deciding from chat apps

A Recipient can connect **LINE, Slack or Microsoft Teams** to their account. Then:
- Decision Requests, NEEDS_INFO questions and Spec Proposals arrive there as cards.
- A card shows the question, the Choices with their impact, and buttons: pick a Choice, Ask for more info, or Open in Vorasaan.
- A Spec Proposal card only links to the web app, because a diff needs a real screen.

These rules keep it safe:
- **Account linking:** a one-time code from Vorasaan connects the chat account to the person. A button press counts as that person only when it comes from the linked account.
- **Callbacks:** each provider's callbacks are verified with its signature, Slack signing secret, LINE channel secret or Teams JWT, before anything is read.
- **Same rules as the web:** pressing a Choice calls the same service as the web app. A request that changed since the card was sent answers "this was already decided by …" instead of acting.
- **What a card carries:** only the title, the Choices and a link, never Attachment contents. The rest stays in Vorasaan.

## Rejected
- **Auto-deciding or auto-reassigning after a timeout.** It is faster, but it breaks the rule that a person decides.
- **Email only.** It is already possible, and the Decision Requests still wait.
- **One chat app only.** In Thailand LINE is where people actually answer, and many companies run on Slack or Teams.
