import { isKnownTimeZone } from '@vorasaan/shared';

/** Every IANA time zone the browser knows, with `current` first if it isn't among them. */
export function timeZones(current: string): string[] {
  try {
    const all = Intl.supportedValuesOf('timeZone');
    return all.includes(current) ? all : [current, ...all];
  } catch {
    return [current];
  }
}

/**
 * The browser's time zone, such as Asia/Bangkok (ticket 0063), or UTC when the browser
 * doesn't say or says something that isn't an IANA zone. `intl` is for tests.
 */
export function browserTimeZone(intl: Pick<typeof Intl, 'DateTimeFormat'> = Intl): string {
  try {
    const zone = intl.DateTimeFormat().resolvedOptions().timeZone;
    // What the TimeZone schema accepts, checked without loading Zod on the page.
    return typeof zone === 'string' && zone.trim() && isKnownTimeZone(zone.trim()) ? zone : 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * Other names people type for a zone (ticket 0077): Thai names, countries and big cities that
 * aren't in the IANA id. Small on purpose; the id's own city ("Bangkok") always matches.
 */
export const TIME_ZONE_ALIASES: Record<string, string[]> = {
  'Asia/Bangkok': ['กรุงเทพ', 'กรุงเทพมหานคร', 'ไทย', 'ประเทศไทย', 'Thailand', 'Krung Thep'],
  'Asia/Vientiane': ['เวียงจันทน์', 'ลาว', 'Laos'],
  'Asia/Phnom_Penh': ['พนมเปญ', 'กัมพูชา', 'Cambodia'],
  'Asia/Yangon': ['ย่างกุ้ง', 'พม่า', 'เมียนมา', 'Myanmar', 'Rangoon'],
  'Asia/Ho_Chi_Minh': ['โฮจิมินห์', 'ไซ่ง่อน', 'เวียดนาม', 'Vietnam', 'Saigon', 'Hanoi'],
  'Asia/Kuala_Lumpur': ['กัวลาลัมเปอร์', 'มาเลเซีย', 'Malaysia'],
  'Asia/Singapore': ['สิงคโปร์'],
  'Asia/Jakarta': ['จาการ์ตา', 'อินโดนีเซีย', 'Indonesia'],
  'Asia/Manila': ['มะนิลา', 'ฟิลิปปินส์', 'Philippines'],
  'Asia/Hong_Kong': ['ฮ่องกง'],
  'Asia/Shanghai': ['เซี่ยงไฮ้', 'ปักกิ่ง', 'จีน', 'China', 'Beijing'],
  'Asia/Taipei': ['ไทเป', 'ไต้หวัน', 'Taiwan'],
  'Asia/Tokyo': ['โตเกียว', 'ญี่ปุ่น', 'Japan'],
  'Asia/Seoul': ['โซล', 'เกาหลี', 'Korea'],
  'Asia/Kolkata': ['อินเดีย', 'India', 'Mumbai', 'Delhi', 'Bangalore'],
  'Asia/Dubai': ['ดูไบ', 'UAE'],
  'Australia/Sydney': ['ซิดนีย์', 'ออสเตรเลีย', 'Australia'],
  'Europe/London': ['ลอนดอน', 'อังกฤษ', 'UK', 'Britain'],
  'Europe/Paris': ['ปารีส', 'ฝรั่งเศส', 'France'],
  'Europe/Berlin': ['เบอร์ลิน', 'เยอรมนี', 'Germany'],
  'America/New_York': ['นิวยอร์ก', 'US Eastern'],
  'America/Los_Angeles': ['ลอสแอนเจลิส', 'ซานฟรานซิสโก', 'San Francisco', 'US Pacific'],
  UTC: ['GMT', 'Coordinated Universal Time'],
};

/** "UTC+07:00" for `timeZone` at `at`, "UTC+00:00" for UTC itself. */
export function timeZoneOffset(timeZone: string, at: Date = new Date()): string {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
      .formatToParts(at)
      .find((p) => p.type === 'timeZoneName')?.value;
    return `UTC${part?.replace('GMT', '') || '+00:00'}`;
  } catch {
    return 'UTC';
  }
}

export type TimeZoneOption = {
  id: string;
  /** The id's city, readable: "Ho Chi Minh". */
  city: string;
  offset: string;
  aliases: string[];
};

/** Every zone of `timeZones(current)` with its city, current offset and aliases. */
export function timeZoneOptions(current: string, at: Date = new Date()): TimeZoneOption[] {
  return timeZones(current).map((id) => ({
    id,
    city: (id.split('/').at(-1) ?? id).replaceAll('_', ' '),
    offset: timeZoneOffset(id, at),
    aliases: TIME_ZONE_ALIASES[id] ?? [],
  }));
}

const fold = (text: string) => text.toLocaleLowerCase('en').replace(/[\s_/-]+/g, ' ');

/** Whether every word of `query` is in the zone's id, city, offset or aliases. */
export function matchesTimeZone(option: TimeZoneOption, query: string): boolean {
  const hay = fold([option.id, option.city, option.offset, ...option.aliases].join(' '));
  return fold(query)
    .split(' ')
    .filter(Boolean)
    .every((word) => hay.includes(word));
}

/** The zones matching `query`, in their usual order. */
export function searchTimeZones(options: TimeZoneOption[], query: string): TimeZoneOption[] {
  return options.filter((o) => matchesTimeZone(o, query));
}
