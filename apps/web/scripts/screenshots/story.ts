// The story the README screenshots tell: a Thai bank's Mobile Banking team, written the
// way such a team writes (English product language with Thai where people would use it).
// seed.ts writes it through the API; model.ts answers the AI tasks from it.

import type { ChoiceDraft, TeamRole } from '@vorasaan/shared';

export const ORGANIZATION = 'Saranrom Bank';

export type Person = { key: string; name: string; email: string };
const person = (key: string, name: string): Person => ({
  key,
  name,
  email: `${key}@saranrom.example`,
});

export const PEOPLE = {
  pim: person('pim', 'Pim Wongsakul'),
  mint: person('mint', 'Mint Chaiyaporn'),
  fern: person('fern', 'Fern Rattanakorn'),
  oak: person('oak', 'Oak Srisuk'),
  beam: person('beam', 'Beam Thongdee'),
  ploy: person('ploy', 'Ploy Kittisak'),
  nok: person('nok', 'Nok Jantarasri'),
} as const;
export type PersonKey = keyof typeof PEOPLE;

/** Team Roles per Team. Pim (the first Admin) is set up through /setup. */
export const TEAMS: Record<string, Partial<Record<PersonKey, TeamRole[]>>> = {
  Payments: {
    pim: ['PO'],
    mint: ['PO'],
    fern: ['DESIGNER'],
    oak: ['TECH_LEAD'],
    beam: ['BACKEND'],
    ploy: ['MOBILE'],
    nok: ['QA'],
  },
  Onboarding: { mint: ['PO'], fern: ['DESIGNER'], oak: ['TECH_LEAD'], ploy: ['MOBILE'] },
};

export const BRIEF = `# Project Brief

## Business goals
- Grow monthly QR payments from 4.2M to 6M transactions by Q4 2026.
- Open 30% of new savings accounts in the app instead of at a branch.

## Users
- Retail customers, mostly paying by QR at shops, markets and online checkouts.
- Small merchants (แม่ค้า, ร้านกาแฟ) who check incoming payments on the same app.

## What it already does
Transfers, PromptPay, bill payment, statements and card controls on iOS and Android.

## Constraints
- Bank of Thailand rules: face verification for transfers of 50,000 THB or more.
- PDPA: no full account numbers or citizen IDs in logs or on slips.
- ITMX runs PromptPay; its sandbox is slower than production at lunch peak.

## Non-goals
- Investment and insurance products.
- A separate merchant app.
`;

const SPEC_QR_RULES = `## Rules
- Supports PromptPay IDs (mobile number, citizen ID, e-wallet) and Thai merchant QR (Tag 29 and Tag 30).
- The amount in a dynamic QR cannot be edited.
- Per-transaction limit: 50,000 THB. The daily QR limit follows the customer's transfer limit.
- 50,000 THB or more needs face verification (Bank of Thailand rule).`;

const specQr = (rules: string, extraCriteria = '') => `# PromptPay QR payments

## Goal
Let customers pay any Thai QR from the app in under 10 seconds, without typing an amount when the QR already has one.

## Users
- **Customer** paying at a shop, a market stall or an online checkout.
- **Merchant** who needs the money, and the slip, right away.
- **Contact center agent** answering "ตัดเงินแล้ว แต่ร้านบอกว่ายังไม่ได้รับ".

## User flow
1. Customer taps **Scan** on the home screen, or picks a QR image from the gallery.
2. The app reads the QR and shows the receiver's masked name, the amount and the source account.
3. Customer confirms with PIN or biometrics.
4. The app shows the e-slip with a reference number and **Save slip**.

${rules}

## Acceptance criteria
- [ ] Scan to e-slip in under 10 seconds at p95.
- [ ] A QR that fails its CRC check shows "QR นี้ไม่ถูกต้อง" and never calls the payment API.
- [ ] A payment is never shown as successful before ITMX confirms it.
- [ ] The e-slip carries a mini QR that the receiver's bank can verify.${extraCriteria}

## Out of scope
- Cross-border QR (PromptPay ⇄ DuitNow, PayNow).
- Paying by credit card.
`;

const RULE_MASKED_SLIP =
  "- The e-slip shows the payer's account number masked to its last 4 digits (xxx-x-x1234-x).";
const RULE_DUPLICATE =
  '- Paying the same QR with the same amount again within 2 minutes asks first: "คุณเพิ่งจ่ายรายการนี้ไปเมื่อสักครู่ ต้องการจ่ายซ้ำไหม?"';

export const SPEC_QR_V1 = specQr(SPEC_QR_RULES);
export const SPEC_QR_V2 = specQr(`${SPEC_QR_RULES}\n${RULE_MASKED_SLIP}`);
/** What Pim's Conversation proposes on top of v2 (left for her to approve). */
export const SPEC_QR_DUPLICATE_PROPOSAL = specQr(
  `${SPEC_QR_RULES}\n${RULE_MASKED_SLIP}\n${RULE_DUPLICATE}`,
  '\n- [ ] A second payment of the same QR and amount within 2 minutes needs one more tap to confirm.',
);

const specScheduled = (extraRule = '') => `# Scheduled transfers

## Goal
Let customers set up a transfer once (rent, ค่าเทอม, money to parents) and have it run on a date every month.

## User flow
1. From a finished transfer, the customer taps **Repeat monthly**, or starts from **Scheduled** in the menu.
2. They pick the day of the month, an end date or a number of times, and confirm with PIN.
3. On the day, the transfer runs at 06:00 and the customer gets a push with the result.

## Rules
- Up to 20 active schedules per customer.
- A schedule that fails twice in a row (not enough money) pauses and tells the customer.
- Days 29–31 run on the last day of shorter months.${extraRule}

## Acceptance criteria
- [ ] A customer can pause, edit or delete a schedule; changes apply from the next run.
- [ ] Every run shows in the statement as "Scheduled transfer" with the schedule's name.
`;

export const SPEC_SCHEDULED_V1 = specScheduled();

export const SPEC_EKYC_V1 = `# eKYC with NDID

## Goal
Open a savings account in the app, without visiting a branch, by verifying identity through NDID.

## User flow
1. Customer scans the front of their ID card and takes a selfie with a liveness check.
2. They pick an NDID identity provider (another bank they already use) and approve there.
3. The account is opened and ready for PromptPay in under 10 minutes.

## Acceptance criteria
- [ ] Liveness check passes on phones from the last 5 years at 720p.
- [ ] A rejected NDID approval explains what to do next in Thai and English.
`;

export type FeatureStory = {
  key: string;
  team: keyof typeof TEAMS;
  title: string;
  description: string;
  jiraIssueKey: string;
  owners: Partial<Record<PersonKey, TeamRole[]>>;
  spec: string;
};

export const FEATURES: FeatureStory[] = [
  {
    key: 'qr',
    team: 'Payments',
    title: 'PromptPay QR payments',
    description: 'Scan any Thai QR and pay in under 10 seconds.',
    jiraIssueKey: 'MB-412',
    owners: {
      pim: ['PO'],
      mint: ['PO'],
      fern: ['DESIGNER'],
      oak: ['TECH_LEAD'],
      beam: ['BACKEND'],
      ploy: ['MOBILE'],
      nok: ['QA'],
    },
    spec: SPEC_QR_V1,
  },
  {
    key: 'scheduled',
    team: 'Payments',
    title: 'Scheduled transfers',
    description: 'Set up a transfer once and let it run every month.',
    jiraIssueKey: 'MB-388',
    owners: {
      pim: ['PO'],
      fern: ['DESIGNER'],
      oak: ['TECH_LEAD'],
      beam: ['BACKEND'],
      ploy: ['MOBILE'],
    },
    spec: SPEC_SCHEDULED_V1,
  },
  {
    key: 'ekyc',
    team: 'Onboarding',
    title: 'eKYC with NDID',
    description: 'Open a savings account without visiting a branch.',
    jiraIssueKey: 'MB-301',
    owners: { mint: ['PO'], fern: ['DESIGNER'], oak: ['TECH_LEAD'], ploy: ['MOBILE'] },
    spec: SPEC_EKYC_V1,
  },
];

// ─── Decision Requests ───────────────────────────────────────────────────────

/** What the scripted model drafts as Choices, by the Decision Request's title. */
export const CHOICES: Record<string, { suggestedRole: TeamRole; choices: ChoiceDraft[] }> = {};

const choices = (title: string, suggestedRole: TeamRole, list: Omit<ChoiceDraft, 'label'>[]) => {
  CHOICES[title] = {
    suggestedRole,
    choices: list.map((c, i) => ({ label: 'ABCD'[i] as string, ...c })),
  };
  return title;
};

export type RequestStory = {
  feature: string;
  raiser: PersonKey;
  kind: 'BLOCKER' | 'QUESTION';
  title: string;
  description: string;
  deciderRole: TeamRole;
  /** When it was sent, for the times on screen (written afterwards, see age.ts). */
  hoursAgo: number;
  withChoices?: boolean;
  /** Decided by this person, picking the Choice with this label. */
  decide?: { by: PersonKey; label: string; rationale: string; approveSpec: boolean };
};

export const SLIP_MASKING = choices(
  "How much of the payer's account number should the e-slip show?",
  'PO',
  [
    {
      title: 'Last 4 digits only (xxx-x-x1234-x)',
      description:
        'Mask everything but the last 4 digits, as most Thai banks do on their slips. The receiver can still match the payment.',
      impactScope: 'Slip template and the slip verification API',
      impactTime: '+0.5 day',
      impactRisk: 'Low',
    },
    {
      title: 'The full account number',
      description: 'Show the whole number, so merchants can refund to it without asking.',
      impactScope: 'None',
      impactTime: 'None',
      impactRisk: 'High: PDPA, and slips get shared in LINE groups',
    },
    {
      title: 'Account name only, no number',
      description: "Show the payer's masked name and no account number at all.",
      impactScope: 'Slip template',
      impactTime: '+0.5 day',
      impactRisk: 'Medium: merchants with many payers can’t tell two Somchais apart',
    },
  ],
);

export const HOLIDAY_RUNS = choices(
  'What happens when a scheduled transfer falls on a bank holiday?',
  'PO',
  [
    {
      title: 'Run it on the next business day',
      description:
        'Move the run to the next business day and say so in the push. Core banking standing orders already work this way.',
      impactScope: 'Holiday calendar lookup in the scheduler',
      impactTime: '+1 day',
      impactRisk: 'Low: rent may arrive a day or two late after Songkran',
    },
    {
      title: 'Run it on the business day before',
      description: 'Pay early rather than late, so rent and ค่าเทอม are never overdue.',
      impactScope: 'Holiday calendar lookup, plus a balance check a day earlier',
      impactTime: '+2 days',
      impactRisk: 'Medium: more failures, because salary may not be in yet',
    },
    {
      title: 'Run it on the holiday anyway',
      description: 'PromptPay and ORFT run on holidays, so just run it on the day.',
      impactScope: 'None',
      impactTime: 'None',
      impactRisk: 'Medium: transfers to some banks settle a day later anyway',
    },
  ],
);

export const PROMPTPAY_TARGETS = choices(
  'Can a scheduled transfer go to a PromptPay ID, or only to an account number?',
  'PO',
  [
    {
      title: 'Account numbers only for the first release',
      description: 'Keep schedules to account numbers; add PromptPay IDs later.',
      impactScope: 'Hide PromptPay in the schedule form',
      impactTime: 'None',
      impactRisk: 'Low, but customers asked for PromptPay in the beta survey',
    },
    {
      title: 'PromptPay IDs, looked up at every run',
      description:
        'Store the PromptPay ID and look it up each time, so a change of bank on the other side still works.',
      impactScope: 'ITMX lookup in the scheduler, a new failure reason',
      impactTime: '+3 days',
      impactRisk: 'Medium: the receiver could change and the money goes somewhere new',
    },
    {
      title: 'PromptPay IDs, locked to the account found when scheduling',
      description: 'Look the ID up once, show the masked name, and pay that account every time.',
      impactScope: 'ITMX lookup when scheduling, re-confirm if it changes',
      impactTime: '+4 days',
      impactRisk: 'Low',
    },
  ],
);

export const SAVE_SLIP = choices(
  'Should the app save the e-slip to the photo gallery automatically?',
  'PO',
  [
    {
      title: 'Ask the first time, then remember',
      description: 'Ask once after the first QR payment and keep the answer in Settings.',
      impactScope: 'One prompt and a setting',
      impactTime: '+1 day',
      impactRisk: 'Low',
    },
    {
      title: 'Always save',
      description: 'Save every slip, like most Thai banking apps do today.',
      impactScope: 'Gallery permission on first payment',
      impactTime: '+0.5 day',
      impactRisk: 'Medium: galleries fill up with slips, and some customers complain',
    },
    {
      title: 'Never; Save slip button only',
      description: 'Keep the gallery clean and let customers save the slips they need.',
      impactScope: 'None',
      impactTime: 'None',
      impactRisk: 'Medium: merchants ask for a slip the customer never saved',
    },
  ],
);

export const TEN_SECONDS = choices(
  'Where does the 10-second "scan to e-slip" target start and stop?',
  'PO',
  [
    {
      title: 'From opening the scanner to the e-slip on screen',
      description: 'Measure what the customer feels, including the time to aim the camera.',
      impactScope: 'Client-side timing events',
      impactTime: '+1 day',
      impactRisk: 'Medium: camera focus on old Android phones eats most of the budget',
    },
    {
      title: 'From the confirm tap to the e-slip on screen',
      description: 'Measure only what we control: our API, ITMX and the slip.',
      impactScope: 'Server and client timing events',
      impactTime: '+1 day',
      impactRisk: 'Low',
    },
  ],
);

export const IDEMPOTENCY = choices(
  'Who generates the idempotency key for a QR payment?',
  'TECH_LEAD',
  [
    {
      title: 'The app, one UUID per confirm tap',
      description: 'Simple, and a retry from the app reuses the same key.',
      impactScope: 'Mobile and the payment API',
      impactTime: '+1 day',
      impactRisk: 'Medium: a reinstalled app or a second phone can pay twice',
    },
    {
      title: 'The server, as a payment intent before confirm',
      description:
        'Create a payment intent when the QR is read; confirm pays that intent at most once.',
      impactScope: 'New intent endpoint and table',
      impactTime: '+3 days',
      impactRisk: 'Low',
    },
    {
      title: 'A hash of the QR, the account and the minute',
      description: 'No new state, and duplicates within the same minute are blocked.',
      impactScope: 'Payment API only',
      impactTime: '+0.5 day',
      impactRisk: 'High: two real payments of the same QR in one minute are blocked',
    },
  ],
);

export const SCHEDULER = choices(
  'Should scheduled transfers run in the core banking batch or in our own scheduler?',
  'TECH_LEAD',
  [
    {
      title: 'Core banking batch at 05:00',
      description: 'Use the standing-order batch the branches already use.',
      impactScope: 'A new batch file format with the core team',
      impactTime: '+5 days (core team queue)',
      impactRisk: 'Medium: no push until the batch report lands at 07:30',
    },
    {
      title: 'Our own scheduler on the payment service',
      description: 'Run each schedule as an ordinary transfer, with our retries and pushes.',
      impactScope: 'Scheduler, locks, and monitoring',
      impactTime: '+4 days',
      impactRisk: 'Medium: we own the on-call for it',
    },
  ],
);

export const MERCHANT_NAME = choices(
  'Show the name in the QR or the merchant’s registered name?',
  'PO',
  [
    {
      title: 'The registered name from the ITMX lookup',
      description:
        'Look the merchant up before confirm and show the masked registered name, as for a transfer.',
      impactScope: 'One lookup call before the confirm screen',
      impactTime: '+1 day',
      impactRisk: 'Low: adds about 300 ms before confirm',
    },
    {
      title: 'The name in the QR (Tag 59)',
      description: 'No extra call: show the name the merchant printed in the QR.',
      impactScope: 'None',
      impactTime: 'None',
      impactRisk: 'High: a fake QR can show any name',
    },
    {
      title: 'Both: the QR name, the registered name below it',
      description: 'Show "ร้านป้าแดง" with "นาง แดง ใ***" under it.',
      impactScope: 'Confirm screen layout',
      impactTime: '+2 days',
      impactRisk: 'Low: a longer screen on small phones',
    },
  ],
);

export const BETA_ENVIRONMENT = choices(
  'Which ITMX environment does the October beta run on?',
  'TECH_LEAD',
  [
    {
      title: 'Production, for 500 staff accounts only',
      description: 'Real money and real latency, limited to a whitelist of staff accounts.',
      impactScope: 'Whitelist flag on the QR entry point',
      impactTime: '+1 day',
      impactRisk: 'Low: staff report problems before customers see them',
    },
    {
      title: 'UAT, with test accounts',
      description: 'No real money, but the sandbox is slower and its QR data is fake.',
      impactScope: 'None',
      impactTime: 'None',
      impactRisk: 'Medium: peak latency and real merchant QR are never tested',
    },
  ],
);

/** What the CLI raise types (the screenshot of `vorasaan raise`). */
export const CLI_RAISE = {
  title: MERCHANT_NAME,
  description:
    'Tag 30 QR มีชื่อร้านอยู่ใน QR แต่ชื่อที่จดทะเบียนกับ ITMX อาจไม่ตรงกัน. Which one goes on the confirm screen and the e-slip?',
};

export const REQUESTS: RequestStory[] = [
  {
    feature: 'qr',
    raiser: 'beam',
    kind: 'QUESTION',
    title: SLIP_MASKING,
    description:
      'The slip template from the old app shows the full account number. ก่อนผมแก้ API ของ slip verification: how much of it should we show?',
    deciderRole: 'PO',
    hoursAgo: 50,
    decide: {
      by: 'pim',
      label: 'A',
      rationale:
        'Same as other banks, and PDPA: the full number isn’t needed to confirm a payment.',
      approveSpec: true,
    },
  },
  {
    feature: 'qr',
    raiser: 'pim',
    kind: 'QUESTION',
    title: BETA_ENVIRONMENT,
    description: 'Marketing wants to announce the beta on 20 Oct. ต้องรู้ก่อนว่าใช้ environment ไหน.',
    deciderRole: 'TECH_LEAD',
    hoursAgo: 30,
    decide: {
      by: 'oak',
      label: 'A',
      rationale: 'UAT can’t show us lunch-peak latency, which is the whole risk of this Feature.',
      approveSpec: false,
    },
  },
  {
    feature: 'scheduled',
    raiser: 'fern',
    kind: 'QUESTION',
    title: HOLIDAY_RUNS,
    description:
      'I’m drawing the date picker. วันหยุดธนาคารต้องเลือกได้ไหม, and what do we tell the customer when the day is a holiday?',
    deciderRole: 'PO',
    hoursAgo: 26,
    decide: {
      by: 'pim',
      label: 'A',
      rationale: 'ตรงกับ standing order ที่ลูกค้าคุ้นอยู่แล้ว, and core banking does it this way.',
      approveSpec: false,
    },
  },
  {
    feature: 'scheduled',
    raiser: 'beam',
    kind: 'BLOCKER',
    title: PROMPTPAY_TARGETS,
    description:
      'The schedule table only has account numbers. ถ้าจะรองรับ PromptPay ต้องเปลี่ยน schema ตอนนี้ก่อน migration รอบหน้า.',
    deciderRole: 'PO',
    hoursAgo: 4,
  },
  {
    feature: 'qr',
    raiser: 'ploy',
    kind: 'QUESTION',
    title: SAVE_SLIP,
    description: 'iOS asks for photo permission the first time we save. ควรถามตอนไหนดี?',
    deciderRole: 'PO',
    hoursAgo: 7,
  },
  {
    feature: 'qr',
    raiser: 'nok',
    kind: 'QUESTION',
    title: TEN_SECONDS,
    description:
      'I’m writing the performance test cases. The Spec says "scan to e-slip in under 10 seconds" but not where the clock starts.',
    deciderRole: 'PO',
    hoursAgo: 2.5,
  },
  {
    feature: 'qr',
    raiser: 'beam',
    kind: 'BLOCKER',
    title: IDEMPOTENCY,
    description:
      'We had double payments in UAT when the network dropped after confirm. ต้องตกลงกันก่อนว่า key มาจากไหน.',
    deciderRole: 'TECH_LEAD',
    hoursAgo: 1.5,
  },
  {
    feature: 'scheduled',
    raiser: 'ploy',
    kind: 'QUESTION',
    title: SCHEDULER,
    description: 'The push design depends on when we know the result.',
    deciderRole: 'TECH_LEAD',
    hoursAgo: 20,
  },
  {
    feature: 'qr',
    raiser: 'nok',
    kind: 'QUESTION',
    title: 'Can QA get an ITMX sandbox account with peak-latency simulation before UAT?',
    description: 'ต้องใช้ทดสอบ timeout ช่วง 12:00–13:00 ก่อน UAT รอบ 2 (14 Oct).',
    deciderRole: 'TECH_LEAD',
    hoursAgo: 0.7,
    withChoices: false,
  },
];

// ─── Spec Proposals drafted after a Decision (by the Decision Request's title) ──

export const SPEC_PROPOSALS: Record<string, { proposedMarkdown: string; summary: string }> = {
  [BETA_ENVIRONMENT]: {
    proposedMarkdown: `${SPEC_QR_V2.trimEnd()}\n\n## Beta\n- The October beta runs on ITMX production for 500 whitelisted staff accounts.\n`,
    summary: 'Adds the beta plan: ITMX production, 500 staff accounts.',
  },
  [SLIP_MASKING]: {
    proposedMarkdown: SPEC_QR_V2,
    summary: "Masks the payer's account number on the e-slip to its last 4 digits.",
  },
  [HOLIDAY_RUNS]: {
    proposedMarkdown: specScheduled(
      '\n- A run that falls on a bank holiday moves to the next business day; the push says so.',
    ),
    summary: 'Moves runs on bank holidays to the next business day.',
  },
};

// ─── Conversations ───────────────────────────────────────────────────────────

/** One scripted chat reply: text, then optionally one tool call. */
export type ChatReply = { text: string; tool?: { name: string; args: unknown } };

export const HERO_REQUEST = {
  title: 'What should the customer see when ITMX takes more than 5 seconds to confirm?',
  description:
    'At lunch peak the ITMX sandbox answers in 6–9 s, but our payment API times out at 5 s. ลูกค้าเห็น error ทั้งที่เงินอาจถูกตัดไปแล้ว, and contact center gets the call. The Spec says a payment is never shown as successful before ITMX confirms it, but not what to show while we wait.',
};

choices(HERO_REQUEST.title, 'PO', [
  {
    title: 'Show “Processing” and confirm by push',
    description:
      'Go to the e-slip at 5 s with a Processing status, keep checking ITMX for up to 60 s, then update the slip and send a push.',
    impactScope: 'Processing state on the e-slip, a status check job, one push template',
    impactTime: '+4 days (Backend 2, Mobile 2)',
    impactRisk: 'Low: some customers may pay again; the duplicate-payment warning covers it',
  },
  {
    title: 'Wait up to 15 seconds on a progress screen',
    description: 'Raise our timeout to 15 s and keep the customer on a progress screen.',
    impactScope: 'Timeout setting and a progress animation',
    impactTime: '+1 day',
    impactRisk: 'Medium: people close the app while waiting, and past 15 s we still need a plan',
  },
  {
    title: 'Fail at 5 seconds and reverse automatically',
    description:
      'Treat no answer in 5 s as failed, send a reversal to ITMX, and let the customer pay again.',
    impactScope: 'Reversal job and a reconciliation report for Ops',
    impactTime: '+6 days',
    impactRisk: 'High: reversals settle T+1, so the money is gone overnight',
  },
]);

export type ConversationStory = {
  owner: PersonKey;
  scope: { feature: string } | { project: true };
  turns: { message: string; replies: ChatReply[] }[];
};

/** Before the hero, so it is the newest in Beam's Sidebar. */
export const BEAM_ERRORS: ConversationStory = {
  owner: 'beam',
  scope: { feature: 'qr' },
  turns: [
    {
      message: 'ITMX error codes ไหนบ้างที่ต้องแสดงเป็นข้อความให้ลูกค้าเห็น?',
      replies: [
        {
          text: 'From the Spec and the Decisions so far, only three need their own message on the confirm screen:\n\n- **Receiver not found**: "ไม่พบบัญชีผู้รับ" with a link to scan again.\n- **Over the limit**: "เกินวงเงินต่อรายการ" with the customer’s current limit.\n- **Bank unavailable**: "ธนาคารปลายทางไม่พร้อมให้บริการ" and a retry.\n\nEverything else can share the general error. Want me to draft a Spec Proposal with this list for Pim to review?',
        },
      ],
    },
  ],
};

export const HERO: ConversationStory = {
  owner: 'beam',
  scope: { feature: 'qr' },
  turns: [
    {
      message:
        'ช่วง peak เที่ยง ITMX sandbox ตอบช้า 6–9 วิ but our timeout is 5 s. ลูกค้าเห็น error ทั้งที่เงินอาจถูกตัดไปแล้ว. What should we do?',
      replies: [
        {
          text: 'The Spec covers half of this: *a payment is never shown as successful before ITMX confirms it*. It doesn’t say what the customer sees while we wait, or for how long. That is the PO’s call, and your timeout work is stuck until it’s made, so I drafted it as a Blocker with three Choices.',
          tool: {
            name: 'draftDecisionRequest',
            args: { kind: 'BLOCKER', ...HERO_REQUEST },
          },
        },
        {
          text: 'Review the Choices and send it to the PO when it reads right. Pim and Mint are the Feature’s PO Role Owners, so either of them can Claim it.',
        },
      ],
    },
  ],
};

export const PIM_SPEC_CHANGE: ConversationStory = {
  owner: 'pim',
  scope: { feature: 'qr' },
  turns: [
    {
      message:
        'Contact center บอกว่ามีลูกค้าจ่าย QR ซ้ำเยอะ เพราะกดยืนยันสองครั้ง. Add a warning when the same QR and amount is paid again within 2 minutes.',
      replies: [
        {
          text: 'I drafted the change: one new rule with the warning text, and an acceptance criterion so QA can test it. Nothing else in the Spec changes.',
          tool: {
            name: 'draftSpecProposal',
            args: {
              proposedMarkdown: SPEC_QR_DUPLICATE_PROPOSAL,
              summary: 'Warns before paying the same QR and amount twice within 2 minutes.',
            },
          },
        },
        {
          text: 'Approving it writes Spec v3. Beam’s timeout Blocker is still open; the Processing state it may add would show this warning too.',
        },
      ],
    },
  ],
};

export const PIM_PROJECT: ConversationStory = {
  owner: 'pim',
  scope: { project: true },
  turns: [
    {
      message: 'สรุป Blocker ที่ยังเปิดอยู่ใน Payments ให้หน่อย',
      replies: [
        {
          text: 'Payments has two open Blockers:\n\n1. **Scheduled transfers**: *Can a scheduled transfer go to a PromptPay ID, or only to an account number?* Raised by Beam, waiting on a PO. It holds up the schedule table migration.\n2. **PromptPay QR payments**: *Who generates the idempotency key for a QR payment?* Raised by Beam, waiting on Oak (Tech Lead).\n\nThe first one is yours to decide, from your Inbox.',
        },
      ],
    },
  ],
};

// ─── Grilling ───────────────────────────────────────────────────────────────

export const GRILLING_QUESTIONS: Record<string, string[]> = {
  BUSINESS: [
    'What are the top business goals for Mobile Banking this year, and how does management measure them?',
    'Which KPIs tell you a new Feature worked? (เช่น active users, จำนวนธุรกรรม, NPS)',
    'Which customer segments matter most, and who is deliberately not a target?',
    'What must the app never do, from a compliance point of view (BOT, PDPA)?',
    'What is out of scope for this year?',
  ],
  UX: [
    'What are the three journeys customers use most, and where do they drop off?',
    'Which phones and OS versions must the app still support?',
    'What accessibility needs must the app meet (large text, screen readers, older customers)?',
  ],
  TECHNICAL: [
    'What does the architecture behind the app look like today (BFF, core banking, ITMX)?',
    'Which systems does a new Feature usually integrate with, and who owns them?',
    'What are the performance and availability targets for payments?',
  ],
};

export const GRILLING_THIN_ANSWER = 'เพิ่มจำนวนธุรกรรม QR';
const GRILLING_FOLLOW_UP_ANSWER =
  'QR payments from 4.2M to 6M a month by Q4, นับเป็นจำนวนรายการ not value. The second goal is opening 30% of new savings accounts in the app with eKYC, so fewer branch visits.';

/** Pim's answers in her Grilling Conversation; Mint answers question 2 in hers. */
export const GRILLING = {
  pim: [GRILLING_THIN_ANSWER, GRILLING_FOLLOW_UP_ANSWER],
  mint: 'Monthly active users of QR, จำนวนธุรกรรมต่อ user, and the share of payments finished in under 10 s. NPS only quarterly, so we don’t use it for single Features.',
};

/** The scripted model asks one follow-up on a thin answer, until it has a fuller one. */
export const FOLLOW_UPS = [
  {
    when: GRILLING_THIN_ANSWER,
    until: GRILLING_FOLLOW_UP_ANSWER,
    ask: 'From how many to how many, and by when? นับเป็นจำนวนรายการหรือมูลค่า? And is QR the only goal, or is there a second one?',
  },
];
