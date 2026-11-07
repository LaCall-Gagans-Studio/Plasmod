// オーケストレーションの図の線。設定ではなく、カンバンで実際に起きた依頼（誰が誰に頼んだか）から作る。
import { type AgentProfile, findProfile, type KanbanTask } from "./types";

/** 線に数える期間（開いているカードは期間に関係なく数える） */
export const LINK_WINDOW_MS = 7 * 86_400_000;
export const OWNER = "me";

export interface AgentLink {
  /** 頼んだ側（オーナーは OWNER、ほかはエージェントの id） */
  from: string;
  /** 頼まれた側（エージェントの id） */
  to: string;
  /** 依頼の数 */
  count: number;
  /** 今まさに動いているカードがある */
  live: boolean;
}

/** カードの作成者→担当を束ねる。エージェントでない作成者はオーナーの依頼として数え、自分宛ては線にしない */
export function agentLinks(agents: AgentProfile[], tasks: KanbanTask[], now = Date.now()): AgentLink[] {
  const since = (now - LINK_WINDOW_MS) / 1000;
  const links = new Map<string, AgentLink>();
  for (const t of tasks) {
    const to = t.assignee ? findProfile(agents, t.assignee)?.id : undefined;
    if (!to) continue;
    const closed = t.status === "done" || t.status === "archived";
    if (closed && (t.completed_at ?? t.created_at) < since) continue;
    const from = (t.created_by ? findProfile(agents, t.created_by)?.id : undefined) ?? OWNER;
    if (from === to) continue;
    const key = `${from}>${to}`;
    const cur = links.get(key) ?? { from, to, count: 0, live: false };
    links.set(key, { ...cur, count: cur.count + 1, live: cur.live || t.status === "running" });
  }
  return [...links.values()];
}
