// 繰り返しの周期の計算（サーバーの浮上と、画面のカレンダーで同じものを使う）

/** 周期。days は曜日（0=日〜6=土）。monthly の day は 1〜31（その月に無い日は月末）。every は起点（anchor）から n 日ごと */
export type Cadence =
  | { type: "daily" }
  | { type: "weekdays" }
  | { type: "weekly"; days: number[] }
  | { type: "monthly"; day: number }
  | { type: "every"; n: number };

export interface RecurringRule {
  id: number;
  title: string;
  body: string;
  project: string | null;
  cadence: Cadence;
  /** 数え始める日（YYYY-MM-DD）。every はこの日が起点 */
  anchor: string;
  /** 期日の何日前に浮上させるか（0〜60） */
  leadDays: number;
  enabled: boolean;
  /** その回だけやめた日（YYYY-MM-DD） */
  skips: string[];
  createdAt: number;
  updatedAt: number;
}

const DAY = 86_400_000;
export const dayNum = (day: string) => Math.floor(Date.parse(`${day}T00:00:00Z`) / DAY);
export const shiftDay = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const lastDayOfMonth = (day: string) => new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)), 0)).getUTCDate();

/** その日にルールの回が来るか（anchor より前は来ない） */
export function occursOn(rule: Pick<RecurringRule, "cadence" | "anchor">, day: string): boolean {
  if (day < rule.anchor) return false;
  const c = rule.cadence;
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
  switch (c.type) {
    case "daily":
      return true;
    case "weekdays":
      return dow >= 1 && dow <= 5;
    case "weekly":
      return c.days.includes(dow);
    case "monthly":
      return Number(day.slice(8, 10)) === Math.min(c.day, lastDayOfMonth(day));
    case "every":
      return (dayNum(day) - dayNum(rule.anchor)) % c.n === 0;
  }
}

/** from〜to（両端を含む）に来る回の日付。長くても 400 日まで */
export function occurrences(rule: Pick<RecurringRule, "cadence" | "anchor">, from: string, to: string): string[] {
  const out: string[] = [];
  const end = Math.min(dayNum(to), dayNum(from) + 400);
  for (let d = dayNum(from); d <= end; d++) {
    const day = shiftDay("1970-01-01", d);
    if (occursOn(rule, day)) out.push(day);
  }
  return out;
}

const WD = ["日", "月", "火", "水", "木", "金", "土"];

/** 周期を短い言葉に（一覧用） */
export function cadenceLabel(c: Cadence): string {
  switch (c.type) {
    case "daily":
      return "毎日";
    case "weekdays":
      return "平日";
    case "weekly":
      return `毎週 ${c.days.map((d) => WD[d]).join("・")}`;
    case "monthly":
      return `毎月 ${c.day}日`;
    case "every":
      return `${c.n}日ごと`;
  }
}
