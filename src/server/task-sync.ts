// PR のマージでタスクを閉じる（GitHub は読むだけ）。番号の無いタスクに番号を付ける
import type { GitHub } from "./dev";
import type { TaskStore } from "./tasks";

export interface SyncStatus {
  at: number | null;
  ok: boolean;
  error: string | null;
  /** 直近の1回で、作った・変えた・閉じた件数 */
  counts: Record<string, number>;
}

const blank = (): SyncStatus => ({ at: null, ok: true, error: null, counts: {} });

/** PR の題・本文から「Closes TASK-12」「Fixes TASK-3」「Resolves: TASK-7」を拾う（Refs は閉じない） */
export function closingRefs(text: string, teamKey: string): string[] {
  const re = new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s*:?\\s+((?:${teamKey})-\\d{1,6})\\b`, "gi");
  const out = new Set<string>();
  for (const m of text.matchAll(re)) out.add(m[1].toUpperCase());
  return [...out];
}

export class TaskSync {
  readonly prStatus: SyncStatus = blank();
  private timers: ReturnType<typeof setInterval>[] = [];
  private onChange: () => void = () => {};

  constructor(
    private tasks: TaskStore,
    private github: Pick<GitHub, "get"> | null,
    private opts: { owner: string; teamKey: string; closeByPr: boolean },
  ) {}

  start(onChange: () => void, everyMs = 10 * 60_000) {
    this.onChange = onChange;
    const run = () => void this.runAll();
    setTimeout(run, 15_000); // 起動の直後は少し待つ
    this.timers.push(setInterval(run, everyMs));
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
  }

  async runAll(now = Date.now()) {
    let changed = false;
    // 番号の無いタスク（切り替えの前に作られたもの）に番号を付ける。取り込みのあとにする（）
    changed = this.tasks.assignRefs() > 0 || changed;
    if (this.github && this.opts.closeByPr) changed = (await this.closeByMergedPrs(now)) > 0 || changed;
    if (changed) this.onChange();
  }

  /** 直近2日にマージされた PR の「Closes TASK-N」で、タスクを完了にする。済みにした件数を返す */
  async closeByMergedPrs(now = Date.now()): Promise<number> {
    let closed = 0;
    try {
      const since = new Date(now - 2 * 86_400_000).toISOString().slice(0, 10);
      const q = encodeURIComponent(`is:pr is:merged org:${this.opts.owner} merged:>=${since}`);
      const res = (await this.github!.get(`/search/issues?q=${q}&per_page=100`)) as { items?: { title?: string; body?: string | null; number?: number; html_url?: string; repository_url?: string }[] };
      for (const pr of res.items ?? []) {
        const repo = (pr.repository_url ?? "").split("/").slice(-1)[0];
        for (const key of closingRefs(`${pr.title ?? ""}\n${pr.body ?? ""}`, this.opts.teamKey)) {
          if (this.tasks.closeByRef(key, `PR ${repo}#${pr.number} がマージされた ${pr.html_url ?? ""}`.trim(), "github", now)) closed++;
        }
      }
      Object.assign(this.prStatus, { at: now, ok: true, error: null, counts: { closed } });
    } catch (e) {
      Object.assign(this.prStatus, { at: now, ok: false, error: e instanceof Error ? e.message : String(e), counts: { closed } });
    }
    return closed;
  }
}
