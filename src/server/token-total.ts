// プロフィールの生き物を育てる「使ったトークンの総数」。
// 集計元（bridge と Hermes）は直近 7 日・30 日の窓でしか数えられず、通算の数字を持っていない。
// そこで、定期的に窓の合計を見て、増えた分だけを足していく。窓から古い分が抜けても減らさない。
// 窓が古い分を落としながら新しい分を足すときは、その差し引きだけ足すので、実際より少なめに出る（多くは出ない）。
import type { AppSettings } from "./profiles";
import type { UsageSnapshot } from "../shared/types";

const KEY_TOTAL = "token_total";
const KEY_LAST = "token_window_last";
export const TOKEN_EVERY_MS = 5 * 60_000;

/** 窓の合計（Claude の7日 + Hermes の30日） */
export function windowTokens(u: UsageSnapshot): number {
  let n = 0;
  if (!("error" in u.claude)) n += Object.values(u.claude.d7).reduce((a, b) => a + (Number(b) || 0), 0);
  for (const h of Object.values(u.hermes)) if (h && !("error" in h)) n += Number(h.d30?.tokens) || 0;
  return n;
}

export class TokenTotal {
  constructor(private settings: AppSettings) {}

  get(): number {
    return Number(this.settings.get(KEY_TOTAL)) || 0;
  }

  /** 窓の合計を渡す。増えた分だけ足す。初回は、今の合計を出発点にする */
  observe(windowSum: number): number {
    if (!(windowSum >= 0)) return this.get();
    const last = this.settings.get(KEY_LAST);
    let total = this.get();
    if (last === null) total = Math.max(total, windowSum);
    else if (windowSum > Number(last)) total += windowSum - Number(last);
    this.settings.set(KEY_TOTAL, String(Math.round(total)));
    this.settings.set(KEY_LAST, String(Math.round(windowSum)));
    return total;
  }

  start(usage: () => Promise<UsageSnapshot>) {
    const tick = () => void usage().then((u) => this.observe(windowTokens(u)), (e) => console.error("token total", e instanceof Error ? e.message : e));
    tick();
    setInterval(tick, TOKEN_EVERY_MS).unref?.();
  }
}
