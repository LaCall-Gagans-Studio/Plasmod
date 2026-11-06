// 接続の状況（Nous・Hermes の MCP・Claude）。切れたときに、止まる前か止まってすぐ気づけるようにする。
// トークンの値は扱わない。仲介と bridge が返すのは、有無と時刻だけ。
// 確かめるために更新はかけない（Nous の更新トークンは1回限り。外から使うとセッションごと無効になる）。
import type { Database } from "bun:sqlite";
import type { Connection, ConnectionEvent, ConnectionState, ConnectionsView } from "../shared/types";

const EVERY_MS = 15 * 60_000;
const CACHE_MS = 60_000;
const KEEP_EVENTS_MS = 180 * 86_400_000;
const SOON_MS = 7 * 86_400_000;
/** 更新トークンがあるのに、これより長く期限切れのままなら、更新が止まっている疑い */
const STALE_MS = 24 * 3_600_000;

export interface RawToken {
  exists?: boolean;
  access?: boolean;
  refresh?: boolean;
  expires_at?: number | null;
  updated_at?: number | null;
}
export interface RawMcp {
  enabled?: boolean | null;
  oauth?: boolean;
  token?: RawToken;
  log_error?: { at: number; reason: string } | null;
}
export interface RawNous {
  logged_in: boolean;
  obtained_at?: string | null;
  error?: string | null;
  error_at?: number | null;
}
export interface RawHermes {
  nous?: RawNous | null;
  mcp?: Record<string, Record<string, RawMcp>>;
}
export interface RawClaude {
  available?: boolean;
  loggedIn?: boolean;
  authMethod?: string | null;
  loginExpiresAt?: string | null;
}
export interface RawConnections {
  /** どちらも、取れなかったときは Error の文 */
  hermes: RawHermes | { error: string };
  claude: RawClaude | { error: string };
}

const time = (v: string | null | undefined): number | null => {
  const t = v ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : null;
};
const failed = (v: object): v is { error: string } => typeof (v as { error?: unknown }).error === "string";

function claudeRow(raw: RawClaude, now: number): Connection | null {
  if (raw.available === false) return null;
  const expiresAt = time(raw.loginExpiresAt);
  const base = { id: "claude", kind: "claude", name: "Claude", profile: null, canLogin: false, lastRefreshAt: null, expiresAt } as const;
  if (!raw.loggedIn) return { ...base, state: "needs", reason: "ログインしていない" };
  if (expiresAt !== null && expiresAt <= now) return { ...base, state: "needs", reason: "ログインの期限が切れた" };
  if (expiresAt !== null && expiresAt - now < SOON_MS) return { ...base, state: "soon", reason: "ログインの期限が近い" };
  return { ...base, state: "ok", reason: null };
}

function nousRow(raw: RawNous): Connection {
  const base = { id: "nous", kind: "nous", name: "Nous", profile: null, canLogin: true, lastRefreshAt: time(raw.obtained_at), expiresAt: null } as const;
  return raw.logged_in ? { ...base, state: "ok", reason: null } : { ...base, state: "needs", reason: raw.error ?? "ログインしていない" };
}

function mcpRow(profile: string, name: string, raw: RawMcp, now: number): Connection {
  const t = raw.token ?? {};
  const updatedAt = t.updated_at ? t.updated_at * 1000 : null;
  const expiresAt = t.expires_at ? t.expires_at * 1000 : null;
  const row = (state: ConnectionState, reason: string | null): Connection => ({
    id: `mcp:${profile}:${name}`,
    kind: "mcp",
    name,
    profile,
    state,
    reason,
    canLogin: Boolean(raw.oauth || t.exists),
    lastRefreshAt: updatedAt,
    expiresAt,
  });
  if (raw.enabled === false) return row("off", "無効にしている");
  if (!raw.oauth && !t.exists) return row("ok", "ログイン不要");
  if (!t.exists) return row("needs", "ログインしていない");
  const expired = expiresAt !== null && expiresAt <= now;
  if (!t.refresh && expired) return row("needs", "期限が切れ、更新の手段がない");
  // アクセストークンは1時間ほどで切れるのが普通なので、期限だけでは切れた扱いにしない
  const log = raw.log_error;
  if (log && log.at * 1000 > (updatedAt ?? 0)) return row("needs", `更新に失敗した（${log.reason}）`);
  if (expired && now - expiresAt! > STALE_MS) return row("unknown", "しばらく更新されていない");
  return row("ok", null);
}

/** 仲介と bridge の返事を、画面と通知の形にする */
export function connectionRows(raw: RawConnections, now: number): { rows: Connection[]; errors: string[] } {
  const rows: Connection[] = [];
  const errors: string[] = [];
  if (failed(raw.claude)) {
    errors.push(`Claude: ${raw.claude.error}`);
    rows.push({ id: "claude", kind: "claude", name: "Claude", profile: null, state: "unknown", reason: "状態を取得できない", canLogin: false, lastRefreshAt: null, expiresAt: null });
  } else {
    const c = claudeRow(raw.claude, now);
    if (c) rows.push(c);
  }
  if (failed(raw.hermes)) {
    errors.push(`Hermes: ${raw.hermes.error}`);
  } else {
    if (raw.hermes.nous) rows.push(nousRow(raw.hermes.nous));
    for (const [profile, servers] of Object.entries(raw.hermes.mcp ?? {})) {
      for (const [name, s] of Object.entries(servers)) rows.push(mcpRow(profile, name, s, now));
    }
  }
  return { rows, errors };
}

export interface ConnectionNotice {
  key: string;
  title: string;
  message: string;
}

const label = (c: Connection) => (c.profile && c.profile !== "default" ? `${c.name}（${c.profile}）` : c.name);

/** 状態が変わったときの知らせ。無いときは null */
export function connectionNotice(c: Connection, from: ConnectionState | null, now: number): ConnectionNotice | null {
  const key = `connection:${c.id}:${c.state}:${now}`;
  if (c.state === "needs") return { key, title: `${label(c)} の接続が切れた`, message: `${c.reason ?? "つなぎ直しが必要"}。設定の「接続」で確認できます` };
  if (c.state === "soon") {
    const days = c.expiresAt === null ? null : Math.max(0, Math.ceil((c.expiresAt - now) / 86_400_000));
    return { key, title: `${label(c)} の期限が近い`, message: `${days === null ? "もうすぐ" : `あと${days}日で`}切れます。切れる前にログインし直してください` };
  }
  if (c.state === "ok" && (from === "needs" || from === "soon")) return { key, title: `${label(c)} がつながった`, message: "接続は正常です" };
  return null;
}

export class ConnectionWatch {
  private cache: { at: number; view: ConnectionsView } | null = null;

  constructor(
    private db: Database,
    private fetchRaw: () => Promise<RawConnections>,
    private send: (n: ConnectionNotice) => void,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS connection_states (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        since INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS connection_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        conn_id TEXT NOT NULL,
        name TEXT NOT NULL,
        from_state TEXT,
        to_state TEXT NOT NULL,
        reason TEXT
      );
    `);
  }

  private record(rows: Connection[], now: number) {
    const known = new Map(
      (this.db.query("SELECT id, state FROM connection_states").all() as { id: string; state: ConnectionState }[]).map((r) => [r.id, r.state]),
    );
    const notices: ConnectionNotice[] = [];
    this.db.transaction(() => {
      for (const c of rows) {
        // 取れなかっただけのときは前の状態を保つ（直った・切れたの誤報を出さない）
        if (c.state === "unknown") continue;
        const from = known.get(c.id) ?? null;
        if (from === c.state) continue;
        this.db.query("INSERT INTO connection_states (id, state, since) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state, since = excluded.since").run(c.id, c.state, now);
        // 初めて見た正常・無効は、変化ではないので残さない
        if (from === null && (c.state === "ok" || c.state === "off")) continue;
        this.db
          .query("INSERT INTO connection_events (at, conn_id, name, from_state, to_state, reason) VALUES (?, ?, ?, ?, ?, ?)")
          .run(now, c.id, label(c), from, c.state, c.reason);
        const n = connectionNotice(c, from, now);
        if (n) notices.push(n);
      }
      this.db.query("DELETE FROM connection_events WHERE at < ?").run(now - KEEP_EVENTS_MS);
    })();
    // 記録できてから知らせる
    for (const n of notices) this.send(n);
  }

  /** 取り直して記録し、変わったものを知らせる */
  async check(now = Date.now()): Promise<ConnectionsView> {
    const { rows, errors } = connectionRows(await this.fetchRaw(), now);
    this.record(rows, now);
    const events = this.db
      .query("SELECT id, at, conn_id AS connId, name, from_state AS fromState, to_state AS toState, reason FROM connection_events ORDER BY id DESC LIMIT 30")
      .all() as ConnectionEvent[];
    const view: ConnectionsView = { at: now, connections: rows, events, errors };
    this.cache = { at: now, view };
    return view;
  }

  /** 画面用。短い間は覚えておく */
  async view(force = false, now = Date.now()): Promise<ConnectionsView> {
    if (!force && this.cache && now - this.cache.at < CACHE_MS) return this.cache.view;
    return this.check(now);
  }

  start() {
    const tick = () => void this.check().catch((e) => console.error("connections", e instanceof Error ? e.message : e));
    tick();
    setInterval(tick, EVERY_MS).unref?.();
  }
}
