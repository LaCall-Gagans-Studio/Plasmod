// 定期報告: 各プロファイルの cron の出力を仲介（cron-output）で読む。
// 監察チーム（team: "watch"）は週1回の報告、実働チーム（ハブの見回り・ops の朝の運用レポートなど）は日々の報告として、レポートに1枚ずつ出す
import { type AgentProfile, CLAUDE_AGENT, findProfile, type CronJob, type WatchReport } from "../shared/types";
import type { BrokerCall } from "./system";

const DAY = 86400_000;
/** 予定の時刻をこれだけ過ぎても次の予定が進んでいなければ「動いていない」 */
const LATE_MS = 30 * 60_000;

export interface LateJob {
  agent: string;
  name: string;
  reason: string;
}

interface All {
  reports: WatchReport[];
  errors: { agent: string; error: string }[];
  late: LateJob[];
}

export class WatchService {
  private cache: { at: number; value: All } | null = null;

  constructor(
    private broker: BrokerCall | null,
    private profiles: AgentProfile[],
  ) {}

  get configured(): boolean {
    return !!this.broker;
  }

  private teamOf(id: string) {
    return findProfile(this.profiles, id)?.team ?? "work";
  }

  /**
   * 読むプロファイルと cron の一覧。仲介の cron でジョブのあるプロファイル（ops など、アプリの並びに無いものも）。
   * cron が読めなければ、設定のプロファイル（開発エージェントは Hermes ではないので除く）
   */
  private async targets(): Promise<{ ids: string[]; jobs: CronJob[] }> {
    try {
      const r = JSON.parse(await this.broker!("cron")) as Record<string, Omit<CronJob, "profile">[] | { error: string }>;
      const jobs: CronJob[] = [];
      const ids: string[] = [];
      for (const [profile, list] of Object.entries(r)) {
        if (!Array.isArray(list) || list.length === 0) continue;
        ids.push(profile);
        for (const j of list) jobs.push({ ...j, profile });
      }
      return { ids, jobs };
    } catch {
      return { ids: this.profiles.filter((p) => p.id !== CLAUDE_AGENT).map((p) => p.id), jobs: [] };
    }
  }

  /** 全プロファイルの報告を新しい順に（5分はキャッシュ） */
  async all(force = false, now = Date.now()): Promise<All> {
    if (!force && this.cache && now - this.cache.at < 300_000) return this.cache.value;
    const reports: WatchReport[] = [];
    const errors: { agent: string; error: string }[] = [];
    let late: LateJob[] = [];
    if (this.broker) {
      const { ids, jobs } = await this.targets();
      late = lateJobs(jobs, now);
      await Promise.all(
        ids.map(async (id) => {
          try {
            const rows = JSON.parse(await this.broker!("cron-output", id)) as { job: string; name: string; at: number; ok: boolean; text: string }[];
            for (const r of rows) reports.push({ agent: id, job: r.job, name: r.name, at: r.at * 1000, ok: r.ok, text: r.text });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            // プロファイルをまだ作っていないときは、エラーにしない
            if (!/知らないプロファイル/.test(msg)) errors.push({ agent: id, error: msg });
          }
        }),
      );
    }
    reports.sort((a, b) => b.at - a.at);
    const value = { reports, errors, late };
    this.cache = { at: now, value };
    return value;
  }

  private errorOf(errors: All["errors"], team: "work" | "watch") {
    const mine = errors.filter((e) => this.teamOf(e.agent) === team);
    return mine.length ? { error: mine.map((e) => `${e.agent}: ${e.error}`).join(" / ") } : {};
  }

  /** レポートの「今週の監察」: 監察のプロファイルごとに、この8日の最新の1件 */
  async latest(now = Date.now()): Promise<{ items: WatchReport[]; error?: string }> {
    const { reports, errors } = await this.all(false, now);
    const seen = new Set<string>();
    const items = reports.filter((r) => this.teamOf(r.agent) === "watch" && r.at >= now - 8 * DAY && !seen.has(r.agent) && seen.add(r.agent));
    return { items, ...this.errorOf(errors, "watch") };
  }

  /** レポートの「今日の定期報告」: 実働のジョブごとに、この26時間の最新の1件と、動いていないジョブ（監察のものも含む） */
  async routine(now = Date.now()): Promise<{ items: WatchReport[]; late: LateJob[]; error?: string }> {
    const { reports, errors, late } = await this.all(false, now);
    const seen = new Set<string>();
    const items = reports.filter((r) => this.teamOf(r.agent) !== "watch" && r.at >= now - 26 * 3600_000 && !seen.has(`${r.agent}:${r.job}`) && seen.add(`${r.agent}:${r.job}`));
    return { items, late, ...this.errorOf(errors, "work") };
  }
}

/** 有効なのに、前回が失敗した・予定の時刻を過ぎても動いていないジョブ */
export function lateJobs(jobs: CronJob[], now: number): LateJob[] {
  const out: LateJob[] = [];
  for (const j of jobs) {
    if (!j.enabled || j.state === "paused" || j.state === "completed") continue;
    const next = j.next_run_at ? Date.parse(j.next_run_at) : NaN;
    if (j.last_status && /^(error|failed|failure)$/i.test(j.last_status)) out.push({ agent: j.profile, name: j.name, reason: "前回の実行が失敗した" });
    else if (j.state !== "running" && Number.isFinite(next) && next < now - LATE_MS) out.push({ agent: j.profile, name: j.name, reason: "予定の時刻を過ぎても動いていない" });
  }
  return out;
}
