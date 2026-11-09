// セッション。Claude Code は plasmod-bridge、Hermes のエージェント（ハブ・経理エージェント…）は Hermes の API サーバーにつなぐ。
import type { ChatMessage, HermesApproval, HermesMessage, HistoryCursor, MediaItem, OlderPage, SessionInfo, SessionView } from "../shared/types";
import { CLAUDE_AGENT, type RuntimeKind } from "../shared/types";
import type { BridgeClient } from "./bridge";
import type { SessionMark } from "./store";
import { hermesUrl, mediaKind, mediaName, devUrl } from "./media";

export interface HermesEndpoint {
  /** 例: http://127.0.0.1:8642（default）、http://127.0.0.1:8642/p/ritz（名前付きプロファイル） */
  url: string;
  key: string;
}

const toMs = (v: unknown): number => {
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return toMs(n);
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : 0;
  }
  return 0;
};

const listOf = (body: unknown, ...keys: string[]): Record<string, unknown>[] => {
  if (Array.isArray(body)) return body as Record<string, unknown>[];
  const o = (body ?? {}) as Record<string, unknown>;
  for (const k of keys) if (Array.isArray(o[k])) return o[k] as Record<string, unknown>[];
  return [];
};

/** メンション（<@123>）や「📱」の印を外した、読める題名 */
export const cleanTitle = (t: string): string =>
  t.replace(/<[@#][!&]?\d+>/g, "").replace(/^\s*📱\s*/, "").replace(/\s+/g, " ").trim() || "（無題）";

/** content は文字列か、[{type:"text", text}] の配列 */
export const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((p) => (typeof p === "string" ? p : (p as { text?: string }).text ?? ((p as { type?: string }).type === "image_url" ? "[image]" : "")))
      .filter(Boolean)
      .join("\n");
  return "";
};

/**
 * Hermes の返事から、写真・ファイルの指定を取り出す。
 *  - `MEDIA:/path/to/file.png`（Hermes がファイルを返すときの書き方。1行まるごと、または文中）
 *  - 自分が添付したときに本文の末尾に付けた `[添付ファイル]` の行
 * 取り出した分は本文から消す。パスの検査は仲介でやる（ここでは形だけ）
 */
export function extractMedia(text: string): { text: string; paths: string[] } {
  const paths: string[] = [];
  const clean = (p: string) => p.trim().replace(/^[`"']+|[`"']+$/g, "");
  let out = text.replace(/^[ \t]*MEDIA:[ \t]*[`"']?(\/[^\n]+?)[ \t]*$/gm, (_, p: string) => (paths.push(clean(p)), ""));
  out = out.replace(/MEDIA:(\/[^\s`"')]+)/g, (_, p: string) => (paths.push(clean(p)), ""));
  out = out.replace(/\n*\[添付ファイル\]\n((?:\/[^\n]+\n?)+)\s*$/, (_, block: string) => (paths.push(...block.trim().split("\n").map(clean)), ""));
  out = out.replace(/\[\[audio_as_voice\]\]/g, "");
  return { text: out.replace(/\n{3,}/g, "\n\n").trim(), paths: [...new Set(paths)] };
}

/** API の添付の欄（文字列のパス、または {path, name} の配列）から、パスだけ拾う */
function attachedPaths(m: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const k of ["attachments", "media", "files"]) {
    const v = m[k];
    if (!Array.isArray(v)) continue;
    for (const a of v) {
      const p = typeof a === "string" ? a : String((a as { path?: string }).path ?? "");
      if (p.startsWith("/")) out.push(p);
    }
  }
  return out;
}

export function mediaOf(paths: string[]): MediaItem[] {
  return paths.map((p) => ({ name: mediaName(p), url: hermesUrl(p), kind: mediaKind(p) }));
}

// ---- 途中経過（道具を使った記録）を、読める言い回しにする ----
// 動詞は Hermes の locales/ja.yaml の display.verb、引数の取り方は agent/display.py の _PRIMARY_ARGS に合わせる
const TOOL_VERB: Record<string, string> = {
  web_search: "ウェブを検索中", web_extract: "読み込み中", browser_navigate: "ブラウズ中", browser_click: "クリック中", browser_type: "入力中",
  read_file: "読み込み中", write_file: "書き込み中", patch: "編集中", search_files: "ファイルを検索中", terminal: "実行中",
  execute_code: "コードを実行中", image_generate: "画像を生成中", video_generate: "動画を生成中", text_to_speech: "音声を生成中",
  vision_analyze: "画像を確認中", session_search: "過去のセッションを検索中", skill_view: "スキルを読み込み中", skills_list: "スキルを一覧表示中",
  skill_manage: "スキルを更新中", delegate_task: "委任中", cronjob_manage: "スケジュール設定中", clarify: "質問中", memory: "メモリを更新中",
  todo_list: "タスクを更新中",
};
const PRIMARY_ARG: Record<string, string> = {
  terminal: "command", web_search: "query", web_extract: "urls", read_file: "path", write_file: "path", patch: "path",
  search_files: "pattern", browser_navigate: "url", browser_type: "text", image_generate: "prompt", text_to_speech: "text",
  vision_analyze: "question", skill_view: "name", execute_code: "code", delegate_task: "goal", skill_manage: "name",
};
const FALLBACK_ARGS = ["query", "text", "command", "path", "name", "prompt", "code", "goal", "url", "id"];
/** 引数を出さないもの（中身が長い・見せても意味がない） */
const NO_PREVIEW = new Set(["skills_list", "session_search", "memory", "todo_list", "execute_code", "clarify"]);

const oneLine = (v: unknown, max = 80): string => {
  const t = String(Array.isArray(v) ? (v[0] ?? "") : (v ?? "")).split("\n")[0].replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

const argsOf = (raw: unknown): Record<string, unknown> => {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      const v = JSON.parse(raw);
      return v && typeof v === "object" && !Array.isArray(v) ? v : {};
    } catch {
      return {};
    }
  }
  return {};
};

/** 道具の呼び出し1つを「ウェブを検索中: 平遥古城」のような1行にする。MCP は「サーバー名: 道具名」 */
export function toolLabel(name: string, rawArgs: unknown): string {
  const args = argsOf(rawArgs);
  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name);
  const verb = TOOL_VERB[name] ?? (mcp ? `${mcp[1].charAt(0).toUpperCase()}${mcp[1].slice(1)}: ${mcp[2]}` : name);
  if (NO_PREVIEW.has(name)) return verb;
  const key = PRIMARY_ARG[name] ?? FALLBACK_ARGS.find((k) => k in args);
  const preview = key && key in args ? oneLine(name === "read_file" || name === "write_file" || name === "patch" ? String(args[key]).split("/").pop() : args[key]) : "";
  return preview ? `${verb}: ${preview}` : verb;
}

/** 記録の tool_calls（OpenAI 形式 {function: {name, arguments}}、または {name, arguments}）を1行ずつに */
const callLabels = (calls: unknown[]): string[] =>
  calls.map((c) => {
    const o = (c ?? {}) as { function?: { name?: string; arguments?: unknown }; name?: string; arguments?: unknown; args?: unknown };
    return toolLabel(String(o.function?.name ?? o.name ?? "tool"), o.function?.arguments ?? o.arguments ?? o.args);
  });

/** 途中経過を、直前が途中経過ならそこに足し、違えば新しく置く */
function pushSteps(out: HermesMessage[], steps: string[], at?: number) {
  if (!steps.length) return;
  const last = out.at(-1);
  if (last?.role === "steps") {
    last.steps = [...(last.steps ?? []), ...steps];
    if (at) last.at = at;
  } else out.push({ role: "steps", text: "", steps, ...(at ? { at } : {}) });
}

/** 最初に出す件数と、上にスクロールしたときに足す件数。Hermes は API の既定（最新の500件）が最初のページ */
const BRIDGE_FIRST = 60;
const BRIDGE_MAX = 500; // bridge の history は最新から最大500件しか返さない
const HERMES_FIRST = 500;
const TRANSCRIPT_MAX = 200_000;
const OLDER_PAGE = 100;

/** 途中経過の最後がこれより新しければ、まだ作業中とみなす（カンバンなどから始まったターン） */
const STEPS_FRESH_MS = 10 * 60_000;

/** 進行中のターン（ストリームで受けている途中の内容） */
/** Hermes の approvals.timeout の既定（5分）。過ぎると Hermes 側で拒否になる */
const APPROVAL_TTL_MS = 300_000;

interface LiveTurn {
  input: string;
  text: string;
  tools: string[];
  status: "running" | "done" | "failed";
  error?: string;
  at: number;
}

/** 画面に出す文は短く切る。判定は body 全文で行う（Hermes の JSON は日本語が \uXXXX になるので、切った文では後ろの理由が読めない） */
class HermesHttpError extends Error {
  constructor(where: string, readonly status: number, readonly body: string) {
    super(`${where}: HTTP ${status} ${body.slice(0, 200)}`);
  }
}

export class HermesApi {
  constructor(
    readonly profile: string,
    private ep: HermesEndpoint,
    private fetchFn: typeof fetch = fetch,
  ) {}

  private async call(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await this.fetchFn(`${this.ep.url}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${this.ep.key}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
    });
    if (!res.ok) throw new HermesHttpError(`Hermes(${this.profile}) ${path}`, res.status, await res.text());
    return res;
  }

  async list(): Promise<SessionInfo[]> {
    // cron の回が多い（1日4回など）ので、省いても会話が残るよう多めに取る
    const body = await (await this.call("/api/sessions?limit=60")).json();
    return listOf(body, "sessions", "data", "items").map((s) => {
      const id = String(s.id ?? s.session_id);
      return {
        agent: this.profile,
        id,
        title: cleanTitle(String(s.title ?? s.name ?? "")),
        last: toMs(s.updated_at ?? s.last_active ?? s.last_message_at ?? s.started_at ?? s.created_at),
        alive: true,
        working: false,
        // source が返ってこない版でも、cron の回の id は「cron_<ジョブ>_<日時>」
        cron: s.source === "cron" || id.startsWith("cron_"),
      };
    });
  }

  async messages(id: string): Promise<HermesMessage[]> {
    return (await this.page(id)).messages;
  }

  /**
   * 履歴の1ページ。limit を渡すと新しい方から offset 件飛ばして limit 件（並びは古い順）。渡さなければ Hermes の既定（最新の500件）。
   * before を渡すと、それより前の id だけにする（読んでいる間に新しい発言が来て offset がずれても重ならない）
   */
  async page(id: string, opts: { limit?: number; offset?: number; before?: number } = {}): Promise<{ messages: HermesMessage[]; raw: number; oldest: number | null }> {
    const q = new URLSearchParams({ inline_images: "false" });
    if (opts.limit) {
      q.set("limit", String(opts.limit));
      q.set("offset", String(opts.offset ?? 0));
      q.set("order", "latest");
    }
    const body = await (await this.call(`/api/sessions/${encodeURIComponent(id)}/messages?${q}`)).json();
    let rows = listOf(body, "messages", "data", "items");
    const raw = rows.length;
    if (opts.before !== undefined) rows = rows.filter((m) => !(typeof m.id === "number" && m.id >= opts.before!));
    const ids = rows.map((m) => m.id).filter((v): v is number => typeof v === "number");
    return { messages: this.toMessages(rows), raw, oldest: ids.length ? Math.min(...ids) : null };
  }

  private toMessages(rows: Record<string, unknown>[]): HermesMessage[] {
    const out: HermesMessage[] = [];
    for (const m of rows) {
      const role = String(m.role ?? "assistant");
      if (role !== "user" && role !== "assistant") continue; // tool（道具の結果）は出さない
      const x = extractMedia(textOf(m.content ?? m.text));
      const media = mediaOf([...new Set([...x.paths, ...attachedPaths(m)])]);
      if (x.text || media.length) out.push({ role, text: x.text, ...(media.length ? { media } : {}) });
      if (role === "assistant" && Array.isArray(m.tool_calls)) pushSteps(out, callLabels(m.tool_calls), toMs(m.timestamp ?? m.created_at) || undefined);
    }
    return out;
  }

  async create(title: string): Promise<string> {
    // Hermes は題名の重複を許さない（400 invalid_title "already in use"）。カードから話すときは1行目が毎回同じなので、#2・#3… を付けて取り直す
    let res: Response | null = null;
    for (let n = 1; !res; n++) {
      const t = n === 1 ? title : `${title} #${n}`;
      try {
        res = await this.call("/api/sessions", { method: "POST", body: JSON.stringify({ title: t }) });
      } catch (e) {
        if (n >= 20 || !(e instanceof HermesHttpError && e.status === 400 && /already in use/.test(e.body))) throw e;
      }
    }
    const body = (await res.json()) as Record<string, unknown>;
    const s = (body.session ?? body) as Record<string, unknown>;
    const id = s.id ?? s.session_id;
    if (!id) throw new Error(`Hermes(${this.profile}) がセッションの ID を返さなかった`);
    return String(id);
  }

  /** 承認待ちに答える。once=今回だけ許可 / deny=拒否 */
  async answerApproval(runId: string, choice: "once" | "deny", requestId?: string): Promise<void> {
    await this.call(`/v1/runs/${encodeURIComponent(runId)}/approval`, {
      method: "POST",
      body: JSON.stringify({ choice, ...(requestId ? { request_id: requestId } : {}) }),
    });
  }

  /** 1ターン流す。SSE を読みながら onEvent を呼ぶ */
  async chatStream(id: string, input: string, onEvent: (event: string, data: Record<string, unknown>) => void): Promise<void> {
    const res = await this.call(`/api/sessions/${encodeURIComponent(id)}/chat/stream`, {
      method: "POST",
      body: JSON.stringify({ input }),
      headers: { Accept: "text/event-stream" },
    });
    if (!res.body) throw new Error("ストリームが空");
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let event = "message";
    let data = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, "");
        buf = buf.slice(i + 1);
        if (line === "") {
          if (data) {
            let parsed: Record<string, unknown> = {};
            try {
              parsed = JSON.parse(data);
            } catch {
              parsed = { text: data };
            }
            onEvent(String(parsed.type ?? event), parsed);
          }
          event = "message";
          data = "";
        } else if (line.startsWith(":")) {
          // keepalive
        } else if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += (data ? "\n" : "") + line.slice(5).trimStart();
      }
    }
  }
}

const toChat = (m: Record<string, unknown>, thread = ""): ChatMessage => ({
  id: String(m.id ?? ""),
  author: (["owner", "dev", "system", "other"].includes(String(m.author)) ? m.author : "other") as ChatMessage["author"],
  via: m.via ? String(m.via) : null,
  content: String(m.content ?? ""),
  attachments: Array.isArray(m.attachments) ? m.attachments.map(String) : [],
  // bridge が記録したファイル（パスは bridge の中だけ。ここには名前と大きさだけ届く）
  ...(Array.isArray(m.media) && m.media.length
    ? {
        media: (m.media as { name?: string; size?: number }[]).map((f, i) => ({
          name: String(f.name ?? "file"),
          url: devUrl(thread, String(m.id ?? ""), i),
          kind: mediaKind(String(f.name ?? "")),
          ...(typeof f.size === "number" ? { size: f.size } : {}),
        })),
      }
    : {}),
  at: toMs(m.at),
});

/** エージェントを動かす仕組み。できることの違いは RUNTIME_CAPS（shared/types）で宣言する */
export interface AgentRuntime {
  readonly kind: RuntimeKind;
  list(agent: string): Promise<SessionInfo[]>;
  view(agent: string, id: string): Promise<SessionView>;
  transcript(agent: string, id: string): Promise<string>;
  older(agent: string, id: string, before: string, offset?: number): Promise<OlderPage>;
  /** body は空でない本文 */
  send(agent: string, id: string | null, body: string, files: { name: string; data: Uint8Array }[]): Promise<string>;
  stop?(agent: string, id: string): Promise<void>;
}

/** Claude Code（plasmod-bridge 経由。セッションは端末のまま見せる） */
export class ClaudeCodeRuntime implements AgentRuntime {
  readonly kind = "claude-code" as const;
  /** スレッドごとの会話。最初に開いたときに履歴を取り、あとは bridge が流す発言を足す */
  private chats = new Map<string, ChatMessage[]>();
  /** 今の bridge が history に答えない（古い）とき。つなぎ直すまで聞かない */
  private noHistory: string | null = null;

  constructor(
    private bridge: BridgeClient,
    private reply: (agent: string, session: string, text: string) => void,
  ) {
    bridge.onChat((thread, m) => {
      const msg = toChat(m, thread);
      if (msg.author === "dev" && msg.content.trim()) this.reply(CLAUDE_AGENT, thread, msg.content);
      const list = this.chats.get(thread);
      if (!list) return; // まだ開いていないスレッドは、開いたときに履歴を取る
      if (!list.some((x) => x.id === msg.id)) list.push(msg);
      if (list.length > 200) list.splice(0, list.length - 200);
    });
    // つなぎ直したら、取りこぼしがあるかもしれないので履歴から取り直す
    bridge.onChange(() => {
      if (!bridge.connected) {
        this.chats.clear();
        this.noHistory = null;
      }
    });
  }

  private async chat(thread: string): Promise<{ messages?: ChatMessage[]; chatError?: string }> {
    const cached = this.chats.get(thread);
    if (cached) return { messages: cached };
    if (this.noHistory) return { chatError: this.noHistory };
    try {
      const r = await this.bridge.request({ type: "history", thread, limit: BRIDGE_FIRST }, 4000);
      const list = ((r.messages as Record<string, unknown>[]) ?? []).map((m) => toChat(m, thread));
      this.chats.set(thread, list);
      return { messages: list };
    } catch (e) {
      // 古い bridge では履歴が取れない（答えないか「知らない操作」）。画面だけで表示する
      const msg = e instanceof Error ? e.message : String(e);
      if (/返事がない|知らない操作/.test(msg)) this.noHistory = msg;
      return { chatError: msg };
    }
  }

  async list(): Promise<SessionInfo[]> {
      const r = await this.bridge.request({ type: "list_sessions" });
      return ((r.sessions as Record<string, unknown>[]) ?? []).map((s) => ({
        agent: CLAUDE_AGENT,
        id: String(s.thread),
        title: cleanTitle(String(s.title ?? "")),
        last: toMs(s.last),
        alive: !!s.alive,
        working: !!s.working,
      }));
      }

  async view(_agent: string, id: string): Promise<SessionView> {
      const [r, chat] = await Promise.all([this.bridge.request({ type: "pane", thread: id }), this.chat(id)]);
      const first = chat.messages?.[0];
      const cursor: HistoryCursor | undefined = first ? { before: first.id, more: chat.messages!.length >= BRIDGE_FIRST } : undefined;
      return { kind: "terminal", text: String(r.text ?? ""), alive: !!r.alive, working: !!r.working, ...chat, ...(cursor ? { cursor } : {}) };
      }

  async transcript(_agent: string, id: string): Promise<string> {
    let lines: string[];
      const r = await this.bridge.request({ type: "history", thread: id, limit: BRIDGE_MAX }, 8000);
      lines = ((r.messages as Record<string, unknown>[]) ?? []).filter((m) => m.author !== "system").map((m) => String(m.content ?? ""));
    
    return lines.filter(Boolean).join("\n").slice(-TRANSCRIPT_MAX);
    }

  async older(_agent: string, id: string, before: string): Promise<OlderPage> {
      const r = await this.bridge.request({ type: "history", thread: id, limit: BRIDGE_MAX }, 8000);
      const list = ((r.messages as Record<string, unknown>[]) ?? []).map((m) => toChat(m, id));
      const at = list.findIndex((m) => m.id === before);
      if (at < 0) return { messages: [], cursor: { before, more: false, capped: list.length >= BRIDGE_MAX } };
      const start = Math.max(0, at - OLDER_PAGE);
      const page = list.slice(start, at);
      return { messages: page, cursor: { before: page[0]?.id ?? before, more: start > 0, ...(start === 0 && list.length >= BRIDGE_MAX ? { capped: true } : {}) } };
      }

  async send(_agent: string, id: string | null, body: string, files: { name: string; data: Uint8Array }[]): Promise<string> {
      const att = files.map((f) => ({ name: f.name, data: Buffer.from(f.data).toString("base64") }));
      const r = await this.bridge.request({ type: "send", text: body, ...(id ? { thread: id } : {}), ...(att.length ? { files: att } : {}) }, 60_000);
      return String(r.thread);
      }

  async stop(_agent: string, id: string) {
    await this.bridge.request({ type: "stop", thread: id });
  }
}

/** Hermes（HTTP の API。ターンはストリームで受ける） */
export class HermesRuntime implements AgentRuntime {
  readonly kind = "hermes" as const;
  private live = new Map<string, LiveTurn>();
  /** 承認待ち。ターンが終わる・答える・時間切れで消える */
  private approvals = new Map<string, HermesApproval>();
  private approvalSeq = 0;

  constructor(
    private hermes: Map<string, HermesApi>,
    private onChange: () => void,
    private reply: (agent: string, session: string, text: string) => void,
    /** エージェントに渡すファイルを置いて、置いた先のパスを返す（仲介の put-file）。無ければ送れない */
    private putFiles: ((files: { name: string; data: Uint8Array }[]) => Promise<string[]>) | null,
  ) {}

  has(agent: string) {
    return this.hermes.has(agent);
  }

  ids() {
    return [...this.hermes.keys()];
  }

  async list(agent: string): Promise<SessionInfo[]> {
    return this.api(agent).list();
    }

  /** 今答えられる承認待ち（時間切れのものは Hermes 側で拒否になっているので出さない） */
  pendingApprovals(now = Date.now()): HermesApproval[] {
    return [...this.approvals.values()].filter((a) => now - a.createdAt < APPROVAL_TTL_MS);
  }

  async answerApproval(id: string, choice: "once" | "deny"): Promise<void> {
    const a = this.approvals.get(id);
    if (!a || Date.now() - a.createdAt >= APPROVAL_TTL_MS) throw new Error("この承認待ちはもう終わっている");
    await this.api(a.agent).answerApproval(a.runId, choice, a.requestId);
    this.approvals.delete(id);
    this.onChange();
  }

  private addApproval(agent: string, session: string, data: Record<string, unknown>) {
    const a: HermesApproval = {
      id: `${Date.now().toString(36)}-${++this.approvalSeq}`,
      agent,
      session,
      runId: String(data.run_id ?? ""),
      ...(data.request_id ? { requestId: String(data.request_id) } : {}),
      command: String(data.command ?? ""),
      description: String(data.description ?? ""),
      createdAt: Date.now(),
    };
    if (!a.runId) return console.error("approval.request に run_id が無い", agent, session);
    this.approvals.set(a.id, a);
    this.onChange();
    // 時間切れ: Hermes 側で拒否になる（勝手に進まない）。カードを消して、そのことを知らせる
    setTimeout(() => {
      if (!this.approvals.has(a.id)) return;
      this.approvals.delete(a.id);
      this.onChange();
      this.reply(agent, session, `⏱ 承認の期限が切れたので、実行していない: ${a.description || a.command}`.slice(0, 300));
    }, APPROVAL_TTL_MS + 1000).unref?.();
  }

  private clearApprovals(agent: string, session: string) {
    for (const [id, a] of this.approvals) if (a.agent === agent && a.session === session) this.approvals.delete(id);
  }

  private api(agent: string): HermesApi {
    const a = this.hermes.get(agent);
    if (!a) throw new Error(`${agent} のセッションはつながっていない（PLASMOD_HERMES_API に無い）`);
    return a;
  }

  async view(agent: string, id: string): Promise<SessionView> {
    const pg = await this.api(agent).page(id);
    const messages = pg.messages;
    const cursor: HistoryCursor | undefined = pg.oldest !== null ? { before: String(pg.oldest), offset: pg.raw, more: pg.raw >= HERMES_FIRST } : undefined;
    const live = this.live.get(`${agent}:${id}`);
    const tail = messages.at(-1);
    // カンバンなどから始まったターンも、途中経過が新しいうちは作業中に見せる
    const busy = tail?.role === "steps" && !!tail.at && Date.now() - tail.at < STEPS_FRESH_MS;
    if (live && live.status !== "running" && Date.now() - live.at > 120_000) this.live.delete(`${agent}:${id}`);
    // ストリーム中のターンは、履歴にまだ載っていないので後ろに足す
    // Hermes は走り出した時点で発言を履歴に書くことがある。そのときは発言を二重に足さない（最後の発言が同じなら載っている）
    const u = live && extractMedia(live.input);
    const lastUser = messages.findLastIndex((m) => m.role === "user");
    const inHistory = !!u && lastUser >= 0 && messages[lastUser].text.trim() === u.text.trim();
    if (live && u && (live.status === "running" || !inHistory)) {
      if (!inHistory) messages.push({ role: "user", text: u.text, ...(u.paths.length ? { media: mediaOf(u.paths) } : {}) });
      // 途中経過と途中の返事は、履歴にまだ返事が載っていないときだけ足す
      // （途中経過は Hermes が道具を使うたびに記録へ書くので、記録にまだ無い分だけ）
      const after = inHistory ? messages.slice(lastUser + 1) : [];
      const answered = after.some((m) => m.role === "assistant" && m.text);
      if (!answered) pushSteps(messages, live.tools.slice(after.reduce((n, m) => n + (m.steps?.length ?? 0), 0)));
      if (!answered && live.text) {
        const a = extractMedia(live.text);
        messages.push({ role: "assistant", text: a.text, ...(a.paths.length ? { media: mediaOf(a.paths) } : {}) });
      }
    }
    const approval = this.pendingApprovals().find((a) => a.agent === agent && a.session === id);
    return { kind: "chat", messages, alive: true, working: live?.status === "running" || (!live && busy), error: live?.error, ...(cursor ? { cursor } : {}), ...(approval ? { approvalCard: `hperm:${approval.id}` } : {}) };
    }

  async transcript(agent: string, id: string): Promise<string> {
    let lines: string[];
      const pg = await this.api(agent).page(id, { limit: HERMES_FIRST });
      lines = pg.messages.filter((m) => m.role === "user" || m.role === "assistant").map((m) => m.text);
    
    return lines.filter(Boolean).join("\n").slice(-TRANSCRIPT_MAX);
    }

  async older(agent: string, id: string, before: string, offset = 0): Promise<OlderPage> {
    const b = Number(before);
    if (!Number.isFinite(b)) throw new Error("before が数でない");
    const pg = await this.api(agent).page(id, { limit: OLDER_PAGE, offset, before: b });
    return { messages: pg.messages, cursor: { before: String(pg.oldest ?? b), offset: offset + pg.raw, more: pg.raw >= OLDER_PAGE } };
    }

  async send(agent: string, id: string | null, body: string, files: { name: string; data: Uint8Array }[]): Promise<string> {
    const api = this.api(agent);
    if (files.length) {
      if (!this.putFiles) throw new Error("Hermes のエージェントにファイルを送る仲介が設定されていない");
      const paths = await this.putFiles(files);
      body += "\n\n[添付ファイル]\n" + paths.join("\n");
    }
    const sid = id ?? (await api.create(body.split("\n")[0].slice(0, 60)));
    const key = `${agent}:${sid}`;
    if (this.live.get(key)?.status === "running") throw new Error("前のターンがまだ終わっていない");
    const turn: LiveTurn = { input: body, text: "", tools: [], status: "running", at: Date.now() };
    this.live.set(key, turn);
    // ストリームは裏で受ける（画面は view を数秒おきに見る）
    void api
      .chatStream(sid, body, (event, data) => {
        if (event === "assistant.delta") turn.text += String(data.delta ?? data.text ?? "");
        else if (event === "assistant.completed" && !turn.text) turn.text = String(data.text ?? data.content ?? "");
        else if (event === "tool.started") turn.tools.push(toolLabel(String(data.tool_name ?? data.name ?? data.tool ?? "tool"), data.args));
        else if (event === "approval.request") this.addApproval(agent, sid, data);
        else if (event === "run.failed" || event === "run.cancelled") {
          turn.status = "failed";
          turn.error = String(data.error ?? data.message ?? event);
        } else if (event === "run.completed") turn.status = "done";
      })
      .catch((e) => {
        turn.status = "failed";
        turn.error = e instanceof Error ? e.message : String(e);
      })
      .finally(() => {
        if (turn.status === "running") turn.status = "done";
        turn.at = Date.now();
        this.clearApprovals(agent, sid);
        this.onChange();
        if (turn.status === "failed") this.reply(agent, sid, `⚠ うまくいかなかった: ${turn.error ?? ""}`);
        else if (turn.text.trim()) this.reply(agent, sid, extractMedia(turn.text).text);
      });
    return sid;
    }
}

/** エージェントの動かし方ごとの窓口。エージェントの id を見て、hermes か claude-code に振り分ける */
export class SessionService {
  private hermesRt: HermesRuntime;
  private claude: ClaudeCodeRuntime | null;
  /** エージェントが返事をしたとき（Claude Code は発言ごと、Hermes はターンの終わり）。通知に使う */
  private replyListener: (agent: string, session: string, text: string) => void = () => {};

  constructor(
    private bridge: BridgeClient | null,
    hermes: Map<string, HermesApi>,
    onChange: () => void = () => {},
    /** 並べる順（小さいほど先）。プロファイルの設定順を渡す */
    private order: (id: string) => number = () => 0,
    putFiles: ((files: { name: string; data: Uint8Array }[]) => Promise<string[]>) | null = null,
    /** Claude Code の bridge を入れているか。入れていなければ一覧に出さない */
    private claudeEnabled: () => boolean = () => true,
  ) {
    const reply = (agent: string, session: string, text: string) => this.replyListener(agent, session, text);
    this.hermesRt = new HermesRuntime(hermes, onChange, reply, putFiles);
    this.claude = bridge ? new ClaudeCodeRuntime(bridge, reply) : null;
  }

  onReply(fn: (agent: string, session: string, text: string) => void) {
    this.replyListener = fn;
  }

  private rt(agent: string): AgentRuntime {
    // Claude Code を入れていなければ dev も Hermes のプロファイル（#28）
    if (agent !== CLAUDE_AGENT || !this.claudeEnabled()) return this.hermesRt;
    if (!this.claude) throw new Error("plasmod-bridge が設定されていない");
    return this.claude;
  }

  agents(): { id: string; available: boolean; runtime: RuntimeKind }[] {
    const claude = this.claudeEnabled();
    return [
      ...(claude ? [{ id: CLAUDE_AGENT, available: !!this.bridge?.connected, runtime: "claude-code" as const }] : []),
      // Claude Code と同じ id の Hermes プロファイルは、Claude Code を入れているときは出さない（同じ id が2つになる）
      ...this.hermesRt.ids().filter((id) => !(claude && id === CLAUDE_AGENT)).map((id) => ({ id, available: true, runtime: "hermes" as const })),
    ]
      .map((a, i) => ({ a, i }))
      .sort((x, y) => this.order(x.a.id) - this.order(y.a.id) || x.i - y.i)
      .map((x) => x.a);
  }

  async list(agent: string) {
    return this.rt(agent).list(agent);
  }
  async view(agent: string, id: string) {
    return this.rt(agent).view(agent, id);
  }
  /** 検索の索引に入れる本文（発言だけ。途中経過と知らせは入れない）。長い会話は新しい方を残す */
  async transcript(agent: string, id: string) {
    return this.rt(agent).transcript(agent, id);
  }
  /** 上にスクロールしたときの、前の会話。Claude Code は bridge の記録（最新の500件まで）、Hermes は100件ずつ */
  async older(agent: string, id: string, before: string, offset = 0) {
    return this.rt(agent).older(agent, id, before, offset);
  }

  async send(agent: string, id: string | null, text: string, files: { name: string; data: Uint8Array }[] = []): Promise<string> {
    let body = text.trim();
    if (!body && !files.length) throw new Error("本文が空");
    if (!body) body = "（添付を送ります）";
    return this.rt(agent).send(agent, id, body, files);
  }

  async stop(agent: string, id: string) {
    const r = this.rt(agent);
    if (!r.stop) throw new Error("このエージェントのセッションは止められない");
    await r.stop(agent, id);
  }

  /** 今答えられる承認待ち（時間切れのものは Hermes 側で拒否になっているので出さない） */
  pendingApprovals(now = Date.now()) {
    return this.hermesRt.pendingApprovals(now);
  }
  answerApproval(id: string, choice: "once" | "deny") {
    return this.hermesRt.answerApproval(id, choice);
  }
}

/**
 * 一覧にピン・削除を当てる: 削除したものは外し、ピンのものを上に（ピンした新しい順）、ほかは元の並び。
 * ピンしたのに一覧（最新60件）から落ちたものは、覚えておいた題名で出す
 */
export function applyMarks(agent: string, list: SessionInfo[], marks: SessionMark[]): SessionInfo[] {
  const by = new Map(marks.map((m) => [m.id, m]));
  const seen = new Set(list.map((s) => s.id));
  // 付け替えた題名があればそれを出し、元の題名は originalTitle に
  const named = (s: SessionInfo, m: SessionMark | undefined): SessionInfo => (m?.rename ? { ...s, title: m.rename, originalTitle: s.title } : s);
  const kept = list
    .filter((s) => !by.get(s.id)?.hidden_at)
    .map((s) => {
      const m = by.get(s.id);
      return named(m?.pinned_at ? { ...s, pinnedAt: m.pinned_at } : s, m);
    });
  const lost = marks
    .filter((m) => m.pinned_at && !m.hidden_at && !seen.has(m.id))
    .map((m): SessionInfo => named({ agent, id: m.id, title: m.title || "（無題）", last: m.pinned_at!, alive: false, working: false, pinnedAt: m.pinned_at! }, m));
  const all = [...kept, ...lost];
  const pinned = all.filter((s) => s.pinnedAt).sort((a, b) => b.pinnedAt! - a.pinnedAt!);
  return [...pinned, ...all.filter((s) => !s.pinnedAt)];
}

/** PLASMOD_HERMES_API（JSON）: {"default": {"url": "...", "key": "..."}, "acct": {...}} */
export function parseHermesApi(raw: string): Map<string, HermesEndpoint> {
  const m = new Map<string, HermesEndpoint>();
  if (!raw) return m;
  try {
    const o = JSON.parse(raw) as Record<string, HermesEndpoint>;
    for (const [k, v] of Object.entries(o)) if (v?.url && v?.key) m.set(k, { url: v.url.replace(/\/$/, ""), key: v.key });
  } catch {
    console.warn("PLASMOD_HERMES_API が JSON として読めない");
  }
  return m;
}
