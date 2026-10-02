// Thai, English and mixed Spec text whose real token counts are checked in next
// to it (token-fixture.counts.json), so the token estimate can be measured
// against a real tokenizer without loading one at test time (ticket 0059).
// Regenerate the counts after editing any text:
//   bun run --cwd apps/server tokens:fixture

export type TokenSample = { id: string; lang: 'th' | 'en' | 'mixed'; text: string };

/** Thai paragraphs and Spec sections, as people write them: no spaces between words. */
export const THAI_SAMPLES: TokenSample[] = [
  {
    id: 'th-checkout-goal',
    lang: 'th',
    text: 'ลูกค้าต้องชำระเงินผ่านพร้อมเพย์ได้โดยไม่ต้องรอหน้าจอค้าง ระบบจะสร้างคิวอาร์โค้ดให้ทันทีหลังจากกดยืนยันคำสั่งซื้อ และแจ้งผลการชำระเงินภายในสามสิบวินาทีหลังจากธนาคารยืนยันรายการ',
  },
  {
    id: 'th-refund-rules',
    lang: 'th',
    text: 'การคืนเงินทำได้ภายในสิบสี่วันนับจากวันที่ได้รับสินค้า ผู้ขายต้องอนุมัติคำขอคืนเงินก่อนทุกครั้ง หากผู้ขายไม่ตอบกลับภายในสามวันทำการ ระบบจะอนุมัติให้อัตโนมัติและส่งอีเมลแจ้งทั้งสองฝ่าย',
  },
  {
    id: 'th-notifications',
    lang: 'th',
    text: 'ผู้ใช้เลือกได้ว่าจะรับการแจ้งเตือนทางอีเมล ทางไลน์ หรือทางแอปพลิเคชัน การแจ้งเตือนที่เกี่ยวกับความปลอดภัยของบัญชี เช่น การเข้าสู่ระบบจากอุปกรณ์ใหม่ จะถูกส่งทุกช่องทางเสมอ และผู้ใช้ไม่สามารถปิดได้',
  },
  {
    id: 'th-spec-inventory',
    lang: 'th',
    text: [
      '# ระบบจัดการสต็อกสินค้า',
      '',
      '## เป้าหมาย',
      'ร้านค้าเห็นจำนวนสินค้าคงเหลือที่ถูกต้องตลอดเวลา และไม่ขายสินค้าที่หมดแล้ว',
      '',
      '## ขอบเขต',
      '- ตัดสต็อกทันทีเมื่อลูกค้าชำระเงินสำเร็จ',
      '- คืนสต็อกเมื่อคำสั่งซื้อถูกยกเลิกหรือหมดเวลาชำระเงิน',
      '- แจ้งเตือนเจ้าของร้านเมื่อสินค้าเหลือน้อยกว่าจำนวนที่ตั้งไว้',
      '',
      '## สิ่งที่ไม่ทำ',
      'ระบบนี้ไม่รองรับการโอนสต็อกระหว่างสาขาในรอบแรก',
    ].join('\n'),
  },
  {
    id: 'th-spec-login',
    lang: 'th',
    text: [
      '# การเข้าสู่ระบบด้วยรหัสผ่านครั้งเดียว',
      '',
      'ผู้ใช้กรอกหมายเลขโทรศัพท์มือถือ แล้วระบบจะส่งรหัสหกหลักทางข้อความ รหัสใช้ได้ห้านาทีและใช้ได้เพียงครั้งเดียว',
      '',
      '## เงื่อนไข',
      '1. ขอรหัสใหม่ได้หลังจากหกสิบวินาที',
      '2. กรอกรหัสผิดเกินห้าครั้ง บัญชีจะถูกล็อกสิบห้านาที',
      '3. ทุกครั้งที่ล็อก ระบบจะบันทึกเหตุการณ์ไว้ให้ทีมความปลอดภัยตรวจสอบ',
    ].join('\n'),
  },
  {
    id: 'th-decision-shipping',
    lang: 'th',
    text: 'ตัดสินใจแล้วว่าจะใช้ขนส่งเอกชนสองรายเป็นค่าเริ่มต้น เพราะครอบคลุมทุกจังหวัดและมีระบบติดตามพัสดุแบบเรียลไทม์ ค่าส่งคิดตามน้ำหนักจริง ส่วนการส่งแบบด่วนภายในวันเดียวจะเปิดให้เฉพาะกรุงเทพและปริมณฑลก่อน',
  },
  {
    id: 'th-acceptance',
    lang: 'th',
    text: [
      '## เกณฑ์การยอมรับ',
      '- เมื่อลูกค้าสแกนคิวอาร์โค้ดและชำระเงินสำเร็จ หน้าคำสั่งซื้อเปลี่ยนเป็นสถานะชำระแล้วโดยไม่ต้องรีเฟรช',
      '- เมื่อการชำระเงินล้มเหลว ลูกค้าเห็นข้อความที่บอกสาเหตุและปุ่มลองใหม่',
      '- เมื่อคิวอาร์โค้ดหมดอายุ ระบบสร้างโค้ดใหม่ให้ได้โดยไม่ต้องเริ่มสั่งซื้อใหม่',
    ].join('\n'),
  },
];

/** English Spec text: the estimate must stay where it was (±5%). */
export const ENGLISH_SAMPLES: TokenSample[] = [
  {
    id: 'en-checkout-goal',
    lang: 'en',
    text: 'Customers pay with PromptPay without a frozen screen. The system shows a QR code right after the order is confirmed and reports the payment result within thirty seconds of the bank confirming the transfer.',
  },
  {
    id: 'en-refund-rules',
    lang: 'en',
    text: 'Refunds are allowed within fourteen days of delivery. The seller approves every refund request first; if the seller does not answer within three business days, the request is approved automatically and both sides are notified by email.',
  },
  {
    id: 'en-spec-inventory',
    lang: 'en',
    text: [
      '# Inventory management',
      '',
      '## Goal',
      'Shops always see the right stock level and never sell an item that is out of stock.',
      '',
      '## Scope',
      '- Deduct stock as soon as the payment succeeds.',
      '- Return stock when an order is cancelled or its payment times out.',
      '- Alert the shop owner when an item falls below its reorder threshold.',
      '',
      '## Non-goals',
      'Moving stock between branches is out of scope for the first release.',
    ].join('\n'),
  },
  {
    id: 'en-spec-login',
    lang: 'en',
    text: [
      '# One-time password sign-in',
      '',
      'The person enters a mobile number and receives a six-digit code by SMS. The code is valid for five minutes and can be used once.',
      '',
      '## Rules',
      '1. A new code can be requested after 60 seconds.',
      '2. After five wrong codes the account is locked for 15 minutes.',
      '3. Every lock is logged for the security team to review.',
    ].join('\n'),
  },
  {
    id: 'en-decision-shipping',
    lang: 'en',
    text: 'Decided: two private carriers are the default, because they cover every province and offer real-time parcel tracking. Shipping is priced by actual weight; same-day express delivery launches in Bangkok and its vicinity first.',
  },
  {
    id: 'en-api',
    lang: 'en',
    text: [
      '## API',
      '`POST /orders/{orderId}/payments` returns `201` with `{ "qrPayload": string, "expiresAt": ISO-8601 }`.',
      'The webhook `payment.succeeded` is retried with exponential backoff (1s, 2s, 4s ... up to 1h) until it gets a 2xx.',
    ].join('\n'),
  },
];

/** Thai Specs with English product terms, ids and code, as teams really write them. */
export const MIXED_SAMPLES: TokenSample[] = [
  {
    id: 'mixed-webhook',
    lang: 'mixed',
    text: 'เมื่อได้รับ webhook `payment.succeeded` จาก payment gateway ระบบต้องอัปเดต order status เป็น PAID ภายใน 5 วินาที และส่ง push notification ให้ลูกค้า ถ้า webhook ไม่มาภายใน 24 ชั่วโมง ให้ polling ทุก 5 วินาที',
  },
  {
    id: 'mixed-spec-search',
    lang: 'mixed',
    text: [
      '# Search สินค้า',
      '',
      '## เป้าหมาย',
      'ลูกค้าค้นหาสินค้าได้ทั้งภาษาไทยและภาษาอังกฤษ เช่น พิมพ์ว่า "iPhone 16" หรือ "ไอโฟน" ก็เจอสินค้าเดียวกัน',
      '',
      '## Acceptance criteria',
      '- ผลลัพธ์แรกแสดงภายใน 300 ms ที่ p95',
      '- รองรับการสะกดผิดเล็กน้อย (typo tolerance) อย่างน้อยหนึ่งตัวอักษร',
      '- ใช้ Postgres full-text search ไปก่อน ยังไม่ใช้ Elasticsearch',
    ].join('\n'),
  },
  {
    id: 'mixed-decision',
    lang: 'mixed',
    text: 'Decision: ใช้ Next.js 16 กับ App Router สำหรับหน้า checkout เพราะทีมคุ้นเคยอยู่แล้ว ส่วน API ใช้ NestJS ตาม ADR 0003 ไม่ต้องทำ GraphQL ในรอบนี้',
  },
  {
    id: 'mixed-question',
    lang: 'mixed',
    text: 'คำถามถึง PO: ถ้าลูกค้ายกเลิก order หลังจากจ่ายเงินแล้วแต่ร้านยังไม่ได้ส่งของ เราคืนเงินเต็มจำนวนเลยไหม หรือหักค่าธรรมเนียม 3% ของ payment gateway ก่อน',
  },
];

/**
 * Thai Specs of several Features in one Project, each small enough to be one
 * chunk, so every retrieved block is a whole fixture text with a known count.
 */
export const THAI_FEATURES: { title: TokenSample; spec: TokenSample }[] = [
  ['ชำระเงินผ่านพร้อมเพย์', 'th-checkout-goal'],
  ['คืนเงิน', 'th-refund-rules'],
  ['การแจ้งเตือน', 'th-notifications'],
  ['สต็อกสินค้า', 'th-spec-inventory'],
  ['เข้าสู่ระบบด้วย OTP', 'th-spec-login'],
  ['การจัดส่ง', 'th-decision-shipping'],
  ['เกณฑ์การยอมรับการชำระเงิน', 'th-acceptance'],
].map(([title, specId], i) => {
  const spec = THAI_SAMPLES.find((s) => s.id === specId);
  if (!spec) throw new Error(`Unknown Thai sample ${specId}`);
  return {
    // A retrieved Spec block is titled "Spec: <Feature title>".
    title: { id: `th-title-${i + 1}`, lang: 'th' as const, text: `Spec: ${title}` },
    spec,
  };
});

/** Every text with a checked-in count. */
export const TOKEN_SAMPLES: TokenSample[] = [
  ...THAI_SAMPLES,
  ...ENGLISH_SAMPLES,
  ...MIXED_SAMPLES,
  ...THAI_FEATURES.map((f) => f.title),
];
