// 定期報告: 各プロファイルの cron の出力を仲介（cron-output）で読む。
// 実行の間隔が1日以内のジョブは「今日の定期報告」、もっと長いジョブは「今週の報告」として、レポートに1枚ずつ出す。
import { type AgentProfile, CLAUDE_AGENT, type CronJob, type WatchReport } from "../shared/types";
import type { BrokerCall } from "./system";

const DAY = 86400_000;
/** 次の実行まで（予定−前回）がこれより長いジョブは、毎日の報告に入れない */
const LONG_JOB_MS = 36 * 3600_000;
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
  /** 実行の間隔が1日より長いジョブ（プロファイル:ジョブ） */
  longJobs: Set<string>;
}

/** 間隔は設定の文字列を読まず、実際の前回と次回の差で見る。分からないものは毎日の側に入れる */
export function isLongJob(j: CronJob): boolean {
  const gap = Date.parse(j.next_run_at ?? "") - Date.parse(j.last_run_at ?? "");
  return Number.isFinite(gap) && gap > LONG_JOB_MS;
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
    const longJobs = new Set<string>();
    if (this.broker) {
      const { ids, jobs } = await this.targets();
      late = lateJobs(jobs, now);
      for (const j of jobs) if (isLongJob(j)) longJobs.add(`${j.profile}:${j.id}`);
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
    const value = { reports, errors, late, longJobs };
    this.cache = { at: now, value };
    return value;
  }

  /** ジョブごとに最新の1件 */
  private latestPerJob(reports: WatchReport[], match: (r: WatchReport) => boolean): WatchReport[] {
    const seen = new Set<string>();
    return reports.filter((r) => match(r) && !seen.has(`${r.agent}:${r.job}`) && seen.add(`${r.agent}:${r.job}`));
  }

  /** レポートの「今日の定期報告」: 間隔が1日以内のジョブごとに、この26時間の最新の1件と、動いていないジョブ */
  async routine(now = Date.now()): Promise<{ items: WatchReport[]; late: LateJob[]; error?: string }> {
    const { reports, errors, late, longJobs } = await this.all(false, now);
    const items = this.latestPerJob(reports, (r) => !longJobs.has(`${r.agent}:${r.job}`) && r.at >= now - 26 * 3600_000);
    return { items, late, ...(errors.length ? { error: errors.map((e) => `${e.agent}: ${e.error}`).join(" / ") } : {}) };
  }

  /** レポートの「今週の報告」: 間隔が1日より長いジョブごとに、この8日の最新の1件 */
  async weekly(now = Date.now()): Promise<{ items: WatchReport[] }> {
    const { reports, longJobs } = await this.all(false, now);
    return { items: this.latestPerJob(reports, (r) => longJobs.has(`${r.agent}:${r.job}`) && r.at >= now - 8 * DAY) };
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
