// 日付の計算に使うタイムゾーン。サーバーは PLASMOD_TIMEZONE（無ければ OS の設定）、画面はサーバーの値（/api/about）に合わせる。
// 「今日」「今週」「明日の朝」は、どの端末から見ても同じ日付にする。

const system = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

function valid(tz: string | undefined): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const fromEnv = typeof process !== "undefined" ? process.env?.PLASMOD_TIMEZONE : undefined;
let zone = valid(fromEnv) ? fromEnv : system();
let fmt: Intl.DateTimeFormat | null = null;

export const getTimeZone = () => zone;

/** 不正な名前は無視する */
export function setTimeZone(tz: string | undefined) {
  if (!valid(tz) || tz === zone) return;
  zone = tz;
  fmt = null;
}

/** その時刻の、UTC からのずれ（ms）。夏時間も見る */
export function tzOffsetMs(ms: number): number {
  fmt ??= new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
  const p: Record<string, number> = {};
  for (const x of fmt.formatToParts(ms)) if (x.type !== "literal") p[x.type] = Number(x.value);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

/** その時刻の日付（YYYY-MM-DD） */
export const localDay = (ms: number = Date.now()) => new Date(ms + tzOffsetMs(ms)).toISOString().slice(0, 10);
