// 会話を全文検索の索引に入れる（v2.0 D5）。1セッション＝1件。新しい発言があったセッションだけ読み直す。
// cron の回と、一覧から削除したセッションは入れない。
import type { SessionInfo } from "../shared/types";
import type { SearchIndex } from "./search";
import type { SessionMark } from "./store";

const EVERY_MS = 5 * 60_000;
const FIRST_DELAY_MS = 30_000;
/** Hermes や bridge に負担をかけないよう、1件ずつ間を空ける */
const GAP_MS = 50;

export interface TranscriptSource {
  agents(): { id: string; available: boolean }[];
  list(agent: string): Promise<SessionInfo[]>;
  transcript(agent: string, id: string): Promise<string>;
}

export class SessionIndexer {
  private seen = new Map<string, number>();
  private running = false;

  constructor(
    private source: TranscriptSource,
    private search: Pick<SearchIndex, "upsert" | "remove">,
    private marks: (agent: string) => SessionMark[],
    private gapMs = GAP_MS,
  ) {}

  /** 1周する。入れ直した数を返す */
  async run(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let n = 0;
    try {
      for (const { id: agent, available } of this.source.agents()) {
        if (!available) continue;
        try {
          n += await this.runAgent(agent);
        } catch (e) {
          console.error("session index", agent, e instanceof Error ? e.message : e);
        }
      }
    } finally {
      this.running = false;
    }
    return n;
  }

  private async runAgent(agent: string): Promise<number> {
    const hidden = new Set(this.marks(agent).filter((m) => m.hidden_at).map((m) => m.id));
    let n = 0;
    for (const s of await this.source.list(agent)) {
      const ref = `${agent}/${s.id}`;
      if (s.cron) continue;
      if (hidden.has(s.id)) {
        this.search.remove("session", ref);
        this.seen.delete(ref);
        continue;
      }
      if (this.seen.get(ref) === s.last) continue;
      try {
        const text = await this.source.transcript(agent, s.id);
        if (text.trim()) this.search.upsert("session", ref, s.title || "（無題）", text, s.last);
        this.seen.set(ref, s.last);
        n++;
      } catch (e) {
        // 読めなかったセッションは次の周でまた試す
        console.error("session index", ref, e instanceof Error ? e.message : e);
      }
      if (this.gapMs) await Bun.sleep(this.gapMs);
    }
    return n;
  }

  start() {
    const tick = () => void this.run();
    setTimeout(tick, FIRST_DELAY_MS).unref?.();
    setInterval(tick, EVERY_MS).unref?.();
  }
}
