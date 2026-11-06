// 通知（APK の流れ）と、反応がないときの再通知。
import type { Card } from "../shared/types";
import type { Config } from "./config";
import type { NotifyFeed } from "./notify-feed";
import type { Store } from "./store";

const AGENT_LABEL = (cfg: Config, id: string) => cfg.profiles.find((p) => p.id === id)?.name ?? id;

/** 通知のボタンに出す選択肢: 自由入力が要らず、その場で返すものだけ（あとで・自分でやる・不要はアプリで開いて選ぶ） */
const quickOptions = (card: Card) => card.options.filter((o) => !o.needsText && o.tone !== "quiet" && o.id !== "later" && o.id !== "mine").slice(0, 2);

/** APK に送る形。ボタンは選択肢の id（APK は Tailscale 越しに本人として返す） */
export function cardNotice(cfg: Config, card: Card, attempt: number) {
  return {
    kind: "card" as const,
    key: card.key,
    title: `${attempt > 1 ? "【再通知】" : ""}${AGENT_LABEL(cfg, card.agent)} · ${card.statusLabel}`,
    message: `${card.title}\n${card.body}`.slice(0, 1000),
    priority: card.kind === "permission" || attempt > 1 ? 5 : 4,
    path: `#/card/${encodeURIComponent(card.key)}`,
    actions: quickOptions(card).map((o) => ({ label: o.label, option: o.id })),
  };
}

export class Notifier {
  constructor(
    private cfg: Config,
    private store: Store,
    /** アプリ自身の通知の流れ（APK） */
    private feed: NotifyFeed | null = null,
  ) {}

  /** エージェントの返事を知らせる。押すとそのセッションを開く */
  reply(agent: string, session: string, text: string) {
    const body = text.replace(/\n{3,}/g, "\n\n").trim();
    this.feed?.add({
      kind: "reply",
      key: `reply:${agent}:${session}`,
      title: `${AGENT_LABEL(this.cfg, agent)}から返事`,
      message: body.length > 600 ? `${body.slice(0, 600)}…` : body,
      priority: 3,
      path: `#/session/${agent}/${encodeURIComponent(session)}`,
      actions: [],
    });
  }

  /** 今出ているカードについて、初回通知・再通知を行う。定期的に呼ぶ。once に入っているカードは初回の通知だけ */
  async sweep(cards: Card[], now = Date.now(), once: Set<string> = new Set()) {
    // 判断された・無くなったカードの通知は、APK でも消す
    for (const key of this.store.pruneNotifications(new Set(cards.map((c) => c.key)))) this.feed?.clear(key, now);
    for (const card of cards) {
      try {
        const n = this.store.notification(card.key);
        if (!n) {
          this.feed?.add(cardNotice(this.cfg, card, 1));
          this.store.saveNotification(card.key);
          continue;
        }
        if (n.seen_at || once.has(card.key)) continue;
        const due = n.last_sent + this.cfg.renotifyMin * 60_000;
        if (now < due) continue;
        if (n.attempts < this.cfg.renotifyMax) {
          this.feed?.add(cardNotice(this.cfg, card, n.attempts + 1));
          this.store.saveNotification(card.key);
        }
      } catch (e) {
        console.error("notify", card.key, e);
      }
    }
  }
}
