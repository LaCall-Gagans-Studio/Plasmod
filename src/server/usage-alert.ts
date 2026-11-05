// 使用量の枠に当たりそうなときに知らせる（v2.0 G2）。エージェントが止まる前に気づけるように。
// 枠の分かる Nous のクレジットだけを見る（Claude のサブスクは枠の数字が取れない）。
// 同じ期間・同じ段階では1回だけ知らせる。
import type { Database } from "bun:sqlite";
import type { NousCredits } from "../shared/types";

const LEVELS = [
  { at: 0.8, id: "80", label: "80%" },
  { at: 0.95, id: "95", label: "95%" },
] as const;
const EVERY_MS = 30 * 60_000;

export interface UsageNotice {
  key: string;
  title: string;
  message: string;
}

/** 今の状態から、知らせる内容を決める（知らせた記録は見ない） */
export function usageNotice(c: NousCredits): UsageNotice | null {
  if (c.error) return null;
  const period = c.periodEnd ?? "none";
  if (c.paidAccess === false) {
    return { key: `nous:${period}:stop`, title: "Nous の枠が切れた", message: `エージェントが止まっている可能性がある。${c.reason ?? ""}`.trim() };
  }
  if (c.monthly === null || c.monthly <= 0 || c.subscriptionRemaining === null) return null;
  const ratio = (c.monthly - c.subscriptionRemaining) / c.monthly;
  const level = [...LEVELS].reverse().find((l) => ratio >= l.at);
  if (!level) return null;
  const extra = c.purchasedRemaining ? `（買い足し分 $${c.purchasedRemaining.toFixed(2)} あり）` : "";
  return {
    key: `nous:${period}:${level.id}`,
    title: `Nous の枠を ${level.label} 使った`,
    message: `残り $${c.subscriptionRemaining.toFixed(2)} / $${c.monthly.toFixed(2)}${extra}${c.periodEnd ? `。期間の終わり: ${c.periodEnd.slice(0, 10)}` : ""}`,
  };
}

export class UsageAlert {
  constructor(
    private db: Database,
    private credits: () => Promise<NousCredits>,
    private send: (n: UsageNotice) => void,
  ) {
    db.exec("CREATE TABLE IF NOT EXISTS usage_alerts (key TEXT PRIMARY KEY, at INTEGER NOT NULL)");
  }

  async check(now = Date.now()): Promise<boolean> {
    const n = usageNotice(await this.credits());
    if (!n) return false;
    if (this.db.query("SELECT 1 FROM usage_alerts WHERE key = ?").get(n.key)) return false;
    this.db.query("INSERT INTO usage_alerts (key, at) VALUES (?, ?)").run(n.key, now);
    this.send(n);
    return true;
  }

  start() {
    const tick = () => void this.check().catch((e) => console.error("usage alert", e instanceof Error ? e.message : e));
    tick();
    setInterval(tick, EVERY_MS).unref?.();
  }
}
