// セッションの本文（会話・ターミナルの表示）
import { Dots, MiniAmoeba } from "./dots";
import { createContext, type ReactNode, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AgentProfile, ChatMessage, HermesMessage, NousCredits, SessionView } from "../shared/types";
import { Avatar } from "./ui";
import { discard, imageUrl, isDelivered, type Outgoing, retry } from "./outbox";
import { MediaList } from "./Media";
import { ChoiceContext, Linkify, RichText } from "./markdown";
import { parseTerminal, type TermBlock } from "./terminal";
import { UploadBar } from "./upload";
import { usd, creditsUsed, type OlderState } from "./session-data";
import { Skeleton } from "./loading";

/** 自分の発言の吹き出し（右寄せ）。広い画面では横に伸びすぎないよう幅を絞る */
const BUBBLE = "max-w-[88%] self-end whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-chip px-3 py-2 font-sans text-[13px] leading-relaxed text-ink md:max-w-[70%]";

/** 話している相手（返事の左にプロフィール画像と名前を出す）。渡さなければ従来の「⏺」 */
const WhoContext = createContext<AgentProfile | undefined>(undefined);

/** AI の返事（左に相手の画像（無ければ「⏺」）、右に本文。本文に見出し・箇条書きなどの塊があっても揃う）。first なら名前も出す */
function Reply({ children, first = true }: { children: ReactNode; first?: boolean }) {
  const who = useContext(WhoContext);
  return (
    <div className="flex gap-1.5 break-words text-ink">
      {who ? (
        <span className="mt-0.5 flex-none"><Avatar p={who} size={22} /></span>
      ) : (
        <span className="flex-none text-[#D97757]">⏺</span>
      )}
      <div className="min-w-0 flex-1">
        {who && first && <div className="mb-0.5 font-sans text-[11px] font-semibold text-mute">{who.name}</div>}
        {children}
      </div>
    </div>
  );
}

/**
 * 返事の中の選択肢（```choices）を押せるのは、いちばん新しい発言のときだけ（送信中も押せない）。
 * それより前の返事には、次に送った発言を chosen として渡す（押した選択肢に印が付く）
 */
function choiceState<T>(msgs: T[], i: number, isUser: (m: T) => boolean, text: (m: T) => string, choose?: (t: string) => void) {
  const later = msgs.slice(i + 1);
  const next = later.find(isUser);
  return { onChoose: choose, active: !!choose && later.length === 0, chosen: next ? text(next).trim() : undefined };
}

function ChoiceScope({ children, ...v }: { children: ReactNode; onChoose?: (t: string) => void; active: boolean; chosen?: string }) {
  return <ChoiceContext.Provider value={v}>{children}</ChoiceContext.Provider>;
}

function ChatMessageView({ m, first }: { m: ChatMessage; first: boolean }) {
  // 取り出せるファイルがあれば画像・ファイルとして出す。無ければ（古い記録）名前だけ
  const files = m.media?.length ? <MediaList items={m.media} /> : m.attachments.length > 0 && <div className="mt-1 text-[11px] text-mute">📎 {m.attachments.join(", ")}</div>;
  // 見た目は Hermes の会話と同じ（自分の発言は右の吹き出し、返事は「⏺ 」）
  if (m.author === "owner")
    return (
      <div className={BUBBLE}>
        <Linkify text={m.content} />
        {files}
      </div>
    );
  if (m.author === "system" || m.author === "other")
    return <div className="whitespace-pre-wrap break-words text-[11px] leading-snug text-mute">{m.content}</div>;
  return (
    <Reply first={first}>
      <RichText text={m.content} />
      {files}
    </Reply>
  );
}

function TermBlockView({ b, compact }: { b: TermBlock; compact: boolean }) {
  const [open, setOpen] = useState(false);
  switch (b.kind) {
    case "user":
      return <div className={BUBBLE}><Linkify text={b.text} /></div>;
    case "assistant":
      return (
        <div className="flex gap-2 text-[13.5px] leading-relaxed text-ink">
          <span className="mt-[0.55em] size-1.5 flex-none rounded-full bg-[#D97757]" aria-hidden="true" />
          <div className="min-w-0 whitespace-pre-wrap break-words"><Linkify text={b.text} /></div>
        </div>
      );
    case "tool": {
      const shown = open ? b.lines : b.lines.slice(0, compact ? 0 : 2);
      const rest = b.lines.length - shown.length;
      return (
        <div className="ml-3.5 border-l border-line pl-2.5 font-mono text-[10.5px] leading-snug text-mute">
          <div className="truncate">{b.title}</div>
          {shown.map((l, i) => <div key={i} className="truncate pl-2 text-mute">{l}</div>)}
          {rest > 0 && !compact && (
            <button onClick={() => setOpen(true)} className="pl-2 text-[10.5px] text-mute underline-offset-2 hover:underline">…あと {rest} 行</button>
          )}
        </div>
      );
    }
    case "status":
      return (
        <div className="flex items-center gap-2 text-[11px] text-mute">
          <span className="size-1.5 animate-pulse rounded-full bg-lime" aria-hidden="true" />
          {b.text}
        </div>
      );
  }
}

/** 添付の小さなプレビュー（画像はサムネイル、それ以外はファイル名） */
export function Thumb({ f, onRemove }: { f: File; onRemove?: () => void }) {
  const url = useMemo(() => imageUrl(f), [f]);
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);
  return (
    <span className="relative flex h-14 max-w-[150px] flex-none items-center gap-1.5 overflow-hidden rounded-lg border border-line bg-panel pr-2 text-[11px] text-ink-2">
      {url ? <img src={url} alt={f.name} className="h-full w-14 flex-none object-cover" /> : <span className="flex h-full w-10 flex-none items-center justify-center bg-chip text-mute" aria-hidden="true">📄</span>}
      <span className="truncate">{f.name}</span>
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label={`${f.name} を外す`} className="absolute right-0 top-0 flex size-5 items-center justify-center rounded-bl-md bg-ink/70 text-[11px] text-paper">×</button>
      )}
    </span>
  );
}

/** 送信中・送れなかった自分の発言。サーバーの返事を待たずに先に出す */
function OutgoingBubble({ o }: { o: Outgoing }) {
  return (
    <div className="flex max-w-[88%] flex-col items-end gap-1 self-end md:max-w-[70%]">
      <div className={`whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-chip px-3 py-2 text-[13px] leading-relaxed text-ink ${o.status === "sending" ? "opacity-70" : ""} ${o.status === "failed" ? "ring-1 ring-orange" : ""}`}>
        <Linkify text={o.text} />
        {o.files.length > 0 && <div className="mt-1.5 flex flex-wrap gap-1.5">{o.files.map((f, i) => <Thumb key={i} f={f} />)}</div>}
      </div>
      {o.status === "sending" &&
        (o.files.length > 0 ? (
          <div className="w-56 max-w-full"><UploadBar ratio={o.progress ?? 0} files={o.files} /></div>
        ) : (
          <span className="text-[10.5px] text-mute">送っています<Dots /></span>
        ))}
      {o.status === "failed" && (
        <span className="flex items-center gap-2 text-[11px] text-orange-ink" role="alert">
          送れなかった{o.error ? `（${o.error}）` : ""}
          <button onClick={() => void retry(o.key)} className="rounded-md border border-orange px-2 py-0.5">再送</button>
          <button onClick={() => discard(o.key)} className="text-mute underline-offset-2 hover:underline">消す</button>
        </span>
      )}
    </div>
  );
}

/** スクロールする箱。一番下にいるときだけ新しい中身に追従し、遡っているときは「↓」で一番下へ戻れる */
function Scroller({ content, resetKey, className, children, onTop, prepended = 0 }: { content: string; resetKey: string; className: string; children: ReactNode; onTop?: () => void; prepended?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  // 上に前の会話を足したら、その分だけ下げて、読んでいた位置を保つ
  const lastHeight = useRef(0);
  const lastPrepended = useRef(prepended);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (prepended !== lastPrepended.current) {
      if (prepended > lastPrepended.current) el.scrollTop += el.scrollHeight - lastHeight.current;
      lastPrepended.current = prepended;
    }
    lastHeight.current = el.scrollHeight;
  });
  const [away, setAway] = useState(false);
  const toBottom = () => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
    stick.current = true;
    setAway(false);
  };
  // セッションを切り替えた・自分が送ったときは一番下から
  useEffect(toBottom, [resetKey]);
  useEffect(() => {
    if (stick.current && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [content]);
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={ref}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
          setAway(!stick.current);
          if (onTop && el.scrollTop < 160) onTop();
        }}
        className={`${className} overscroll-y-contain`}
      >
        {children}
      </div>
      {away && (
        <button onClick={toBottom} aria-label="一番下へ" className="absolute bottom-2.5 right-3 flex size-9 items-center justify-center rounded-full border border-line-2 bg-panel text-ink shadow-md">
          <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} aria-hidden="true"><path d="M12 5v14M6 13l6 6 6-6" /></svg>
        </button>
      )}
    </div>
  );
}

/** Hermes の途中経過（「ウェブを検索中: …」）。長いときは最後の3行だけ出して、残りは押すと開く */
function StepsView({ steps, compact }: { steps: string[]; compact: boolean }) {
  const [all, setAll] = useState(false);
  const hidden = all ? 0 : Math.max(0, steps.length - 3);
  return (
    <div className="flex flex-col gap-0.5 border-l-2 border-line-2 pl-2.5 text-[11.5px] leading-snug text-mute">
      {hidden > 0 && !compact && (
        <button onClick={() => setAll(true)} className="self-start text-left underline-offset-2 hover:underline">…ほか {hidden} 件</button>
      )}
      {steps.slice(hidden).map((x, i) => <div key={i} className="truncate">{x}</div>)}
    </div>
  );
}

export function CreditsLine({ c }: { c: NousCredits }) {
  const u = creditsUsed(c);
  if (c.paidAccess === false)
    return (
      <div role="status" className="border-b border-line bg-orange/10 px-4 py-2 font-sans text-[12px] text-orange-ink">
        ✕ Nous のクレジット切れ。有料モデルは止まっている{u ? `（${usd(u.used)} / ${usd(u.cap)}）` : ""}。portal で追加するか、無料のモデルに切り替える
      </div>
    );
  if (!u) return null;
  const warn = u.ratio >= 0.75;
  return (
    <div className="flex items-center gap-2.5 border-b border-line px-4 py-1.5 text-[11px] text-mute">
      <span className="flex-none">Nous</span>
      <div className="h-1.5 min-w-0 flex-1 rounded bg-line">
        <div className="h-1.5 rounded" style={{ width: `${Math.max(2, u.ratio * 100)}%`, background: warn ? "#FF8A3D" : "#8FB8FF" }} />
      </div>
      <span className={`flex-none font-mono ${warn ? "text-orange-ink" : ""}`}>{usd(u.used)} / {usd(u.cap)}</span>
    </div>
  );
}

function HistoryTop({ h }: { h: OlderState }) {
  const c = h.cursor;
  if (!c) return null;
  const cls = "flex min-h-8 items-center justify-center gap-2 text-[11px] text-mute";
  if (h.loading)
    return (
      <div className={cls} role="status">
        <span className="gh-spin inline-block size-3 rounded-full border-2 border-line-2 border-t-ink" aria-hidden="true" />
        前の会話を読み込み中…
      </div>
    );
  if (h.error) return <div className={cls}><button onClick={h.load} className="text-orange-ink underline">読み込めなかった（もう一度）</button></div>;
  if (c.more) return <div className={cls}><button onClick={h.load} className="underline-offset-2 hover:underline">↑ 前の会話を読む</button></div>;
  if (c.capped) return <div className={cls}>ここより前は、まだアプリでは読めない（最新の500件まで）</div>;
  return h.items.length ? <div className={cls}>— ここが会話の始まり —</div> : null;
}

/** ターミナルの表示（開発エージェント）か、会話（Hermes）。一番下にいるときだけ追従する */
export function ViewBody({ who, view, compact = false, outgoing = [], scrollKey = "", history, onChoose }: { who?: AgentProfile; view: SessionView | null; compact?: boolean; outgoing?: Outgoing[]; scrollKey?: string; history?: OlderState; onChoose?: (text: string) => void }) {
  const content = (view?.kind === "terminal" ? view.text + (view.messages?.length ?? 0) : JSON.stringify(view?.kind === "chat" ? view.messages : null)) + outgoing.map((o) => o.key + o.status).join();
  const resetKey = `${scrollKey}|${outgoing.length}`;
  const box = (cls: string, children: ReactNode) => (
    <WhoContext.Provider value={who}>
      <Scroller content={content} resetKey={resetKey} className={cls} onTop={history?.load} prepended={history?.items.length ?? 0}>
        {history && <HistoryTop h={history} />}
        {children}
      </Scroller>
    </WhoContext.Provider>
  );
  // 履歴にまだ載っていない自分の発言は、送信中でも先に吹き出しで出す
  const sending = outgoing.filter((o) => !isDelivered(o, view)).map((o) => <OutgoingBubble key={o.key} o={o} />);
  // 送信中・作業中は選択肢を押せない
  const choose = sending.length === 0 && !(view && "working" in view && view.working) ? onChoose : undefined;
  if (!view && sending.length === 0) return <Skeleton />;
  if (!view) return box("flex min-h-0 flex-1 flex-col gap-2.5 overflow-auto p-3.5 font-sans", sending);
  if (view.kind === "terminal") {
    // 会話の記録が無い（古い）セッションで止まっていれば、案内だけ
    if (!view.alive && !view.messages?.length)
      return box(
        "flex min-h-0 flex-1 flex-col gap-2.5 overflow-auto p-3.5 font-sans",
        <>
          <div className="text-[12.5px] text-mute">（このセッションは止まっている。送ると再開する）</div>
          {sending}
        </>,
      );
    const blocks = parseTerminal(view.text);
    if (view.messages) {
      // 会話（発言と返事）を主役にして、画面から取った「今やってること」は作業中だけ下に小さく出す
      const known = new Set(view.messages.map((m) => m.id));
      const all = [...((history?.items ?? []) as ChatMessage[]).filter((m) => !known.has(m.id)), ...view.messages];
      const msgs = compact ? all.slice(-6) : all;
      const activity = view.alive && view.working ? blocks.filter((b) => b.kind === "tool" || b.kind === "status").slice(-3) : [];
      return box(
        "flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-4 font-mono text-[12.5px] leading-relaxed",
        <>
          {msgs.length === 0 && <div className="text-mute">まだ何も話していない</div>}
          {msgs.map((m, i) => (
            <ChoiceScope key={m.id} {...choiceState(msgs, i, (x) => x.author === "owner", (x) => x.content, choose)}>
              <ChatMessageView m={m} first={i === 0 || msgs[i - 1].author === "owner"} />
            </ChoiceScope>
          ))}
          {sending.length > 0 && <div className="flex flex-col gap-2.5 font-sans">{sending}</div>}
          {activity.length > 0 && <div className="flex flex-col gap-1.5 font-sans">{activity.map((b, i) => <TermBlockView key={`a${i}`} b={b} compact />)}</div>}
          {view.alive && view.working && activity.length === 0 && <div className="text-mute"><MiniAmoeba />作業中<Dots /></div>}
          {!view.alive && <div className="text-[11.5px] text-mute">（このセッションは止まっている。送ると再開する）</div>}
        </>,
      );
    }
    return box(
      "flex min-h-0 flex-1 flex-col gap-2.5 overflow-auto p-3.5 font-sans",
      <>
        {(compact ? blocks.slice(-6) : blocks).map((b, i) => <TermBlockView key={i} b={b} compact={compact} />)}
        {sending}
      </>,
    );
  }
  const all = [...((history?.items ?? []) as HermesMessage[]), ...view.messages];
  const msgs = compact ? all.slice(-4) : all;
  return box(
    "flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-4 font-mono text-[12.5px] leading-relaxed",
    <>
      {msgs.length === 0 && <div className="text-mute">まだ何も話していない</div>}
      {msgs.map((m, i) =>
        m.role === "steps" ? (
          <StepsView key={i} steps={m.steps ?? []} compact={compact} />
        ) : m.role === "user" ? (
          <div key={i} className={BUBBLE}><Linkify text={m.text} />{m.media && <MediaList items={m.media} />}</div>
        ) : (
          <ChoiceScope key={i} {...choiceState(msgs, i, (x) => x.role === "user", (x) => x.text, choose)}><Reply first={i === 0 || msgs[i - 1].role === "user"}><RichText text={m.text} />{m.media && <MediaList items={m.media} />}</Reply></ChoiceScope>
        ),
      )}
      {sending.length > 0 && <div className="flex flex-col gap-2.5 font-sans">{sending}</div>}
      {view.approvalCard ? (
        <a className="font-sans text-[13px] text-orange-ink underline" href={`#/card/${encodeURIComponent(view.approvalCard)}`}>⏸ 承認を待っています（開いて判断する）</a>
      ) : view.working && <div className="text-mute"><MiniAmoeba />考えています<Dots /></div>}
      {view.error && <div className="text-orange-ink">⚠ {view.error}</div>}
    </>,
  );
}
