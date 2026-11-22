// cron の5項目（分 時 日 月 曜日）が、どの日のどの時刻に来るか。Hermes の cron をカレンダーに並べるのに使う。
// 時刻はサーバーの時刻（Hermes の cron と同じ）の暦をそのまま使う。

const DAY = 86_400_000;
export const shiftDay = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

const MON = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DOW = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export interface Cron {
  min: number[];
  hour: number[];
  dom: Set<number>;
  mon: Set<number>;
  dow: Set<number>;
  /** 日・曜日が * のとき true。両方に値があるときは、どちらかに合えば来る（cron の決まり） */
  domAny: boolean;
  dowAny: boolean;
}

function field(text: string, lo: number, hi: number, names: string[] = [], nameBase = 0): number[] | null {
  const out = new Set<number>();
  for (const part of text.toLowerCase().split(",")) {
    const [range, stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) return null;
    const num = (s: string): number => {
      const i = names.indexOf(s);
      return i >= 0 ? i + nameBase : /^\d{1,2}$/.test(s) ? Number(s) : NaN;
    };
    let a: number;
    let b: number;
    if (range === "*") [a, b] = [lo, hi];
    else if (range.includes("-")) {
      const [x, y] = range.split("-");
      [a, b] = [num(x), num(y)];
    } else {
      a = num(range);
      b = stepText === undefined ? a : hi;
    }
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < lo || b > hi || a > b) return null;
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return out.size ? [...out].sort((x, y) => x - y) : null;
}

/** 読めない形（@daily・秒つき・範囲外）は null */
export function parseCron(expr: string | null | undefined): Cron | null {
  const f = expr?.trim().split(/\s+/) ?? [];
  if (f.length !== 5) return null;
  const min = field(f[0], 0, 59);
  const hour = field(f[1], 0, 23);
  const dom = field(f[2], 1, 31);
  const mon = field(f[3], 1, 12, MON, 1);
  const dowRaw = field(f[4], 0, 7, DOW, 0);
  if (!min || !hour || !dom || !mon || !dowRaw) return null;
  return {
    min,
    hour,
    dom: new Set(dom),
    mon: new Set(mon),
    dow: new Set(dowRaw.map((d) => d % 7)),
    domAny: f[2].startsWith("*"),
    dowAny: f[4].startsWith("*"),
  };
}

/** その日に来るか */
export function cronOn(c: Cron, day: string): boolean {
  const d = new Date(`${day}T00:00:00Z`);
  if (!c.mon.has(d.getUTCMonth() + 1)) return false;
  const byDom = c.dom.has(d.getUTCDate());
  const byDow = c.dow.has(d.getUTCDay());
  if (c.domAny && c.dowAny) return true;
  if (c.domAny) return byDow;
  if (c.dowAny) return byDom;
  return byDom || byDow;
}

/** 1日のうちの時刻（HH:MM）。来る日はどの日も同じ */
export function cronTimes(c: Cron): string[] {
  const p = (n: number) => String(n).padStart(2, "0");
  return c.hour.flatMap((h) => c.min.map((m) => `${p(h)}:${p(m)}`));
}

/** first〜last（YYYY-MM-DD、両端を含む）で来る日と、その日の時刻。読めない式は null */
export function cronDays(expr: string | null | undefined, first: string, last: string): { day: string; times: string[] }[] | null {
  const c = parseCron(expr);
  if (!c) return null;
  const times = cronTimes(c);
  const out: { day: string; times: string[] }[] = [];
  for (let d = first, n = 0; d <= last && n < 400; d = shiftDay(d, 1), n++) if (cronOn(c, d)) out.push({ day: d, times });
  return out;
}
