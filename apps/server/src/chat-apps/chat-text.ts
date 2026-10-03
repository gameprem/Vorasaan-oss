import {
  CHAT_LINK_CODE_MINUTES,
  CHAT_PROVIDER_LABEL,
  type ChatLanguage,
  type ChatProvider,
  formatSpan,
} from '@vorasaan/shared';

// The fixed text of cards and bot replies, in English and Thai (ticket 0058). Product
// terms (Blocker, Question, Choice, Spec Proposal, Claim) stay in English in both, as
// CONTEXT.md names them; Thai explains around them.

/** How long a LINE reply prompt waits for the person's next message. */
export const PROMPT_MINUTES = 10;

const span = (ms: number, lang: ChatLanguage) => {
  const short = formatSpan(ms);
  if (lang === 'en') return short;
  const unit = short.slice(-1);
  return `${short.slice(0, -1)} ${unit === 'm' ? 'นาที' : unit === 'h' ? 'ชม.' : 'วัน'}`;
};

const choiceText = (choice: { label: string; title: string }) =>
  `Choice ${choice.label}: ${choice.title}`;

/** What a Decision says, for "already decided by …". */
export type DecidedAs = { label: string; title: string } | null;

const en = {
  blocker: 'Blocker',
  question: 'Question',
  from: (name: string) => `From ${name}`,
  due: (date: string, left: number) =>
    left > 0
      ? `Due ${date} (in ${span(left, 'en')})`
      : `Due ${date} (overdue ${span(-left, 'en')})`,
  paused: 'Paused: waiting for more info',
  scope: 'Scope',
  time: 'Time',
  risk: 'Risk',
  choose: (label: string) => `Choose ${label}`,
  ask: 'Ask for more info',
  own: 'Write your own answer',
  ownShort: 'Own answer',
  open: 'Open in Vorasaan',
  review: 'Review in Vorasaan',
  answerInVorasaan: 'Answer in Vorasaan',
  send: 'Send',
  cancel: 'Cancel',
  askTitle: 'Ask for more info',
  askLabel: (raiser: string) => `Your question for ${raiser}`,
  askPlaceholder: 'What do you need to know?',
  ownTitle: 'Your own answer',
  ownLabel: 'Your answer',
  ownPlaceholder: 'What should the team do?',
  answered: (raiser: string, text: string) => `${raiser} answered: ${text}`,
  needsInfoHeading: 'More info needed',
  asks: (decider: string, question: string) => `${decider} asks: ${question}`,
  reminderHeading: 'Reminder: waiting for your decision',
  delegateHeading: 'Escalated to you as Delegate',
  overdueHeading: 'Overdue',
  overdueLine: (names: string) => `Still waiting on ${names}.`,
  proposalHeading: 'Spec Proposal to review',
  proposalLine: 'A diff needs a real screen: review it in Vorasaan.',
  // Request changes (ticket 0065).
  redraft: 'Request changes',
  redraftTitle: 'Request changes',
  redraftChoicesLabel: 'What should the AI change in the Choices?',
  redraftProposalLabel: 'What should the AI change in the Spec Proposal?',
  redraftPlaceholder: 'E.g. "Choice B should keep the old flow" or "answer in Thai, shorter"',
  redraftNow: (n: number) => `Redraft ${n}, after your Request changes.`,
  promptRedraft: `Send what the AI should change as your next message (within ${PROMPT_MINUTES} minutes). Send "cancel" to stop.`,
  redraftStarted: (n: number) => `Writing Redraft ${n}. I'll send the link when it's ready.`,
  redraftReady: (n: number, url: string) =>
    `Redraft ${n} is ready. Nothing changes until it is approved: ${url}`,
  redraftFailed:
    'The AI could not write the Redraft, so nothing changed. Try again, or use Vorasaan.',
  redraftRefused:
    'This can’t be redrafted now: it was approved, declined or changed, a Redraft is being written, or it reached its limit. Open it in Vorasaan.',
  redraftNotAllowed: 'Only whoever approves this can request changes to it.',
  // Replies to a press.
  decided: (choice: DecidedAs) =>
    choice ? `Decided: ${choiceText(choice)}.` : 'Decided with your own answer.',
  proposalReady: (url: string) => `The Spec Proposal is ready to review: ${url}`,
  asked: (raiser: string) => `Your question went to ${raiser}. The request waits for their answer.`,
  alreadyDecided: (name: string, choice: DecidedAs) =>
    `Already decided by ${name}: ${choice ? choiceText(choice) : 'their own answer'}.`,
  youDecided: (choice: DecidedAs) =>
    `You already decided this: ${choice ? choiceText(choice) : 'your own answer'}.`,
  claimedBy: (name: string) =>
    `${name} has Claimed this and decides it now. To Claim it back, open it in Vorasaan.`,
  withdrawn: (name: string) => `Withdrawn by ${name}. Nothing to decide.`,
  waitingForInfo: (raiser: string) => `Waiting for ${raiser} to answer the question first.`,
  notYours: 'This card was sent to someone else, so its buttons don’t work for you.',
  invalidButton: 'That button didn’t work. Open the request in Vorasaan instead.',
  notAllowed: 'You can’t decide this Decision Request. Open it in Vorasaan to see why.',
  draftFailed:
    'Nothing was recorded: drafting the Spec Proposal failed. Try again, or decide in Vorasaan.',
  failed: 'Something went wrong and nothing was recorded. Try again, or use Vorasaan.',
  promptAsk: (raiser: string) =>
    `Send your question for ${raiser} as your next message (within ${PROMPT_MINUTES} minutes). Send "cancel" to stop.`,
  promptOwn: `Send your answer as your next message (within ${PROMPT_MINUTES} minutes). Send "cancel" to stop.`,
  cancelled: 'Cancelled. Nothing was sent.',
  emptyText: 'That was empty, so nothing was sent.',
  // Linking (ticket 0057).
  unlinkedFromChat: "Unlinked from Vorasaan. You won't get Decision Requests here any more.",
  notLinked: (provider: ChatProvider) =>
    `This ${CHAT_PROVIDER_LABEL[provider]} account isn't linked to Vorasaan.`,
  linkedAs: (name: string) => `You're linked to Vorasaan as ${name}. Send "unlink" to disconnect.`,
  howToLink: (provider: ChatProvider) => {
    const label = CHAT_PROVIDER_LABEL[provider];
    return `To link this ${label} account to Vorasaan, open Settings → Notifications in Vorasaan, choose "Link ${label}", and send the code here.`;
  },
  linked: (name: string) =>
    `Linked to Vorasaan as ${name}. Decision Requests sent to you can arrive here. Send "unlink" to disconnect.`,
  tooManyTries: 'Too many wrong codes. Wait 15 minutes, then send a new code from Vorasaan.',
  linkedToSomeoneElse: (provider: ChatProvider) =>
    `This ${CHAT_PROVIDER_LABEL[provider]} account is already linked to another person in Vorasaan. Send "unlink" first, then your code again.`,
  invalidCode: `That code didn't work. It may be mistyped, already used or expired (a code lasts ${CHAT_LINK_CODE_MINUTES} minutes). Get a new one in Vorasaan under Settings → Notifications.`,
  unlinkedBy: (name: string) =>
    `Unlinked from Vorasaan by ${name}. You won't get Decision Requests here any more.`,
};

export type ChatText = typeof en;

const th: ChatText = {
  blocker: 'Blocker (งานหยุดรอ)',
  question: 'Question (คำถาม)',
  from: (name) => `จาก ${name}`,
  due: (date, left) =>
    left > 0
      ? `ครบกำหนด ${date} (อีก ${span(left, 'th')})`
      : `ครบกำหนด ${date} (เลยกำหนด ${span(-left, 'th')})`,
  paused: 'หยุดนับเวลา: รอข้อมูลเพิ่มเติม',
  scope: 'ขอบเขต',
  time: 'เวลา',
  risk: 'ความเสี่ยง',
  choose: (label) => `เลือก ${label}`,
  ask: 'ขอข้อมูลเพิ่ม',
  own: 'ตอบด้วยคำของตัวเอง',
  ownShort: 'ตอบเอง',
  open: 'เปิดใน Vorasaan',
  review: 'ตรวจใน Vorasaan',
  answerInVorasaan: 'ตอบใน Vorasaan',
  send: 'ส่ง',
  cancel: 'ยกเลิก',
  askTitle: 'ขอข้อมูลเพิ่ม',
  askLabel: (raiser) => `คำถามถึง ${raiser}`,
  askPlaceholder: 'อยากทราบอะไรเพิ่ม',
  ownTitle: 'คำตอบของคุณ',
  ownLabel: 'คำตอบ',
  ownPlaceholder: 'ทีมควรทำอย่างไร',
  answered: (raiser, text) => `${raiser} ตอบแล้ว: ${text}`,
  needsInfoHeading: 'มีคนขอข้อมูลเพิ่ม',
  asks: (decider, question) => `${decider} ถาม: ${question}`,
  reminderHeading: 'เตือน: รอคุณตัดสินใจ',
  delegateHeading: 'ส่งต่อถึงคุณในฐานะ Delegate',
  overdueHeading: 'เลยกำหนด',
  overdueLine: (names) => `ยังรอ ${names} อยู่`,
  proposalHeading: 'Spec Proposal รอตรวจ',
  proposalLine: 'การเปลี่ยนแปลงต้องดูบนจอจริง: ตรวจใน Vorasaan',
  redraft: 'ขอให้แก้',
  redraftTitle: 'Request changes (ขอให้แก้)',
  redraftChoicesLabel: 'อยากให้ AI แก้อะไรใน Choice',
  redraftProposalLabel: 'อยากให้ AI แก้อะไรใน Spec Proposal',
  redraftPlaceholder: 'เช่น "Choice B ให้คง flow เดิมไว้" หรือ "ตอบเป็นภาษาไทย สั้นลง"',
  redraftNow: (n) => `Redraft ${n} หลังจากคุณขอให้แก้`,
  promptRedraft: `พิมพ์สิ่งที่อยากให้ AI แก้ในข้อความถัดไป (ภายใน ${PROMPT_MINUTES} นาที) พิมพ์ "ยกเลิก" เพื่อหยุด`,
  redraftStarted: (n) => `กำลังเขียน Redraft ${n} จะส่งลิงก์ให้เมื่อเสร็จ`,
  redraftReady: (n, url) => `Redraft ${n} พร้อมแล้ว ยังไม่มีอะไรเปลี่ยนจนกว่าจะอนุมัติ: ${url}`,
  redraftFailed: 'AI เขียน Redraft ไม่สำเร็จ จึงยังไม่มีอะไรเปลี่ยน ลองอีกครั้ง หรือใช้ Vorasaan',
  redraftRefused:
    'ตอนนี้ขอให้แก้ไม่ได้: อาจอนุมัติ ปฏิเสธ หรือเปลี่ยนไปแล้ว มี Redraft กำลังเขียนอยู่ หรือครบจำนวนครั้งแล้ว เปิดใน Vorasaan',
  redraftNotAllowed: 'เฉพาะผู้อนุมัติเรื่องนี้เท่านั้นที่ขอให้แก้ได้',
  decided: (choice) => (choice ? `ตัดสินใจแล้ว: ${choiceText(choice)}` : 'ตัดสินใจแล้วด้วยคำตอบของคุณเอง'),
  proposalReady: (url) => `Spec Proposal พร้อมให้ตรวจ: ${url}`,
  asked: (raiser) => `ส่งคำถามถึง ${raiser} แล้ว คำขอนี้จะรอคำตอบ`,
  alreadyDecided: (name, choice) =>
    `${name} ตัดสินใจไปแล้ว: ${choice ? choiceText(choice) : 'ด้วยคำตอบของตัวเอง'}`,
  youDecided: (choice) => `คุณตัดสินใจเรื่องนี้ไปแล้ว: ${choice ? choiceText(choice) : 'ด้วยคำตอบของคุณเอง'}`,
  claimedBy: (name) => `${name} Claim เรื่องนี้แล้วและเป็นผู้ตัดสินใจตอนนี้ ถ้าจะ Claim คืน เปิดใน Vorasaan`,
  withdrawn: (name) => `${name} ถอนคำขอนี้แล้ว ไม่ต้องตัดสินใจ`,
  waitingForInfo: (raiser) => `รอ ${raiser} ตอบคำถามก่อน`,
  notYours: 'การ์ดนี้ส่งถึงคนอื่น ปุ่มจึงใช้กับบัญชีของคุณไม่ได้',
  invalidButton: 'ปุ่มนี้ใช้ไม่ได้ เปิดคำขอใน Vorasaan แทน',
  notAllowed: 'คุณตัดสินใจคำขอนี้ไม่ได้ เปิดใน Vorasaan เพื่อดูเหตุผล',
  draftFailed: 'ยังไม่ได้บันทึก: ร่าง Spec Proposal ไม่สำเร็จ ลองอีกครั้ง หรือตัดสินใจใน Vorasaan',
  failed: 'เกิดข้อผิดพลาด ยังไม่ได้บันทึกอะไร ลองอีกครั้ง หรือใช้ Vorasaan',
  promptAsk: (raiser) =>
    `พิมพ์คำถามถึง ${raiser} ในข้อความถัดไป (ภายใน ${PROMPT_MINUTES} นาที) พิมพ์ "ยกเลิก" เพื่อหยุด`,
  promptOwn: `พิมพ์คำตอบของคุณในข้อความถัดไป (ภายใน ${PROMPT_MINUTES} นาที) พิมพ์ "ยกเลิก" เพื่อหยุด`,
  cancelled: 'ยกเลิกแล้ว ไม่ได้ส่งอะไร',
  emptyText: 'ข้อความว่าง จึงไม่ได้ส่งอะไร',
  unlinkedFromChat: 'ยกเลิกการเชื่อมกับ Vorasaan แล้ว จะไม่ได้รับ Decision Request ที่นี่อีก',
  notLinked: (provider) => `บัญชี ${CHAT_PROVIDER_LABEL[provider]} นี้ยังไม่ได้เชื่อมกับ Vorasaan`,
  linkedAs: (name) => `บัญชีนี้เชื่อมกับ Vorasaan ในชื่อ ${name} ส่ง "unlink" เพื่อยกเลิกการเชื่อม`,
  howToLink: (provider) => {
    const label = CHAT_PROVIDER_LABEL[provider];
    return `เชื่อมบัญชี ${label} นี้กับ Vorasaan: เปิด Settings → Notifications ใน Vorasaan เลือก "Link ${label}" แล้วส่งรหัสมาที่นี่`;
  },
  linked: (name) =>
    `เชื่อมกับ Vorasaan ในชื่อ ${name} แล้ว Decision Request ที่ส่งถึงคุณจะมาที่นี่ได้ ส่ง "unlink" เพื่อยกเลิกการเชื่อม`,
  tooManyTries: 'ใส่รหัสผิดหลายครั้งเกินไป รอ 15 นาที แล้วขอรหัสใหม่จาก Vorasaan',
  linkedToSomeoneElse: (provider) =>
    `บัญชี ${CHAT_PROVIDER_LABEL[provider]} นี้เชื่อมกับคนอื่นใน Vorasaan อยู่ ส่ง "unlink" ก่อน แล้วส่งรหัสของคุณอีกครั้ง`,
  invalidCode: `รหัสนี้ใช้ไม่ได้ อาจพิมพ์ผิด ใช้ไปแล้ว หรือหมดอายุ (รหัสใช้ได้ ${CHAT_LINK_CODE_MINUTES} นาที) ขอรหัสใหม่ใน Vorasaan ที่ Settings → Notifications`,
  unlinkedBy: (name) => `${name} ยกเลิกการเชื่อมกับ Vorasaan แล้ว จะไม่ได้รับ Decision Request ที่นี่อีก`,
};

const TEXT: Record<ChatLanguage, ChatText> = { en, th };

export const chatText = (lang: ChatLanguage): ChatText => TEXT[lang];

/** "Fri 3 Oct, 14:00" in the person's language and time zone. */
export function chatDate(at: Date, lang: ChatLanguage, timeZone: string): string {
  return new Intl.DateTimeFormat(lang === 'th' ? 'th-TH' : 'en-GB', {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(at);
}

/** Words that stop a LINE reply prompt. */
export const CANCEL_WORDS = new Set(['cancel', 'ยกเลิก']);
