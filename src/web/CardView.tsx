import { type MouseEvent, useEffect, useRef, useState } from "react";
import type { Card, CardOption, Snapshot, SnoozeKind } from "../shared/types";
import { act, ActFailed, hideCard, markSeen, refreshSnapshot } from "./api";
import { submit } from "./outbox";
import { useAgents } from "./session-data";
import { TaskBadges, refsIn } from "./badges";
import { MicButton } from "./speech";
import { UploadBar, upload } from "./upload";
import { Avatar, Icon, ago, profileOf } from "./ui";
import { CopyRef, toast, useLongPress } from "./touch";
import { AmoebaLoader } from "./loading";
import { ownerName } from "./identity";

const TONE: Record<CardOption["tone"], string> = {
  primary: "bg-lime text-on border-transparent",
  default: "border-line-2 text-ink",
  quiet: "border-line text-mute",
  danger: "border-red-line text-red-ink",
};

const BADGE: Record<string, string> = {
  permission: "bg-orange-soft text-orange-ink",
  blocked: "bg-orange-soft text-orange-ink",
  review: "bg-lime-soft text-lime-ink",
  triage: "bg-blue-soft text-blue",
  note: "bg-blue-soft text-blue",
  confirm: "bg-blue-soft text-blue",
  reply: "bg-blue-soft text-blue",
  todo: "bg-blue-soft text-blue",
};

const SOURCE: Record<string, string> = { mail: "メール", beeper: "Beeper", ops: "ops", imported: "タスク" };

const DOT: Record<Card["kind"], string> = {
  permission: "var(--color-ring-orange)",
  blocked: "var(--color-ring-orange)",
  review: "var(--color-ring-lime)",
  triage: "#8FB8FF",
  note: "#8FB8FF",
  confirm: "#B8A1FF",
  reply: "#B8A1FF",
  todo: "#B8A1FF",
};
const MAX_DOTS = 14;

/** 残りの判断待ち（このカードを含む）。1枚＝1つの印で、色はカードの種類（ホームの輪と同じ）。今のカードは大きく */
function Remaining({ cards, current }: { cards: Card[]; current: string }) {
  const n = cards.length;
  const isCurrent = cards.some((c) => c.key === current);
  const shown = cards.slice(0, MAX_DOTS);
  return (
    <div className="flex items-center gap-2.5 px-4 pt-[max(env(safe-area-inset-top),14px)]" role="status" aria-label={isCurrent ? `残り ${n} 枚（このカードを含む）` : `判断待ち ${n} 枚`}>
      <div className="flex min-w-0 flex-1 items-center gap-1" aria-hidden="true">
        {shown.map((c) => (
          <span
            key={c.key}
            className={`flex-none rounded-full transition-all duration-300 ${c.key === current ? "h-2.5 w-5" : "size-2"}`}
            style={{ background: DOT[c.kind], outline: c.key === current ? "2px solid var(--color-ink)" : undefined, outlineOffset: 1 }}
          />
        ))}
        {n > MAX_DOTS && <span className="flex-none text-[11px] text-mute">+{n - MAX_DOTS}</span>}
      </div>
      <span className="flex-none text-xs font-bold tabular-nums text-ink-2">{isCurrent ? (n === 1 ? "これで最後" : `残り ${n} 枚`) : n ? `判断待ち ${n} 枚` : "判断待ちなし"}</span>
    </div>
  );
}

/** カードが無いとき: 次の判断待ちがあればそこへ、無ければチャットへ */
function NextOrHome({ snap }: { snap: Snapshot }) {
  const first = snap.cards[0];
  return first ? (
    <a href={`#/card/${encodeURIComponent(first.key)}`} className="rounded-full bg-ink px-5 py-3 text-sm font-bold text-paper no-underline">次のカードへ（残り {snap.cards.length} 枚）</a>
  ) : (
    <a href="#/" className="rounded-full border border-line-2 px-5 py-3 text-sm">チャットへ</a>
  );
}

/** エージェントとの相談の最初のメッセージ: カードの中身と、オーナーのひとこと */
export function talkText(card: Card, note: string): string {
  const meta = [
    `種類: ${card.statusLabel}`,
    card.source ? `元: ${card.source}${card.ref ? ` ${card.ref}` : ""}` : card.ref ? `元: ${card.ref}` : "",
    card.url ? `リンク: ${card.url}` : "",
    card.taskId ? `カンバン: ${card.taskId}` : "",
    card.appTaskId ? `タスク: #${card.appTaskId}（Plasmod）` : card.recordRef ? `タスク: ${card.recordRef}（Plasmod）` : "",
  ].filter(Boolean);
  return [
    // 1行目がセッションの題名になる（Hermes は先頭60字、開発エージェントはセッション名）。あとで一覧から探せるようにカードの題名を先頭に
    `${card.title.replace(/\s+/g, " ").trim()}（相談）`,
    "Plasmod のカードについて相談したいです。まだ判断はしていません（カードは残してあります）。",
    meta.join("\n"),
    card.body ? `---\n${card.body}\n---` : "",
    note.trim() ? `${ownerName()}から: ${note.trim()}` : "どう判断するのがよいか、意見をください。",
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 8000);
}

/**
 * 「〇〇と話す」: ほかの選択肢と同じ形のボタン。左の顔を押すと話す相手が順に切り替わる
 * （カードを出したエージェント → 任せる先 → ほか）。ボタンを押すと、カードの中身を最初のメッセージにしてチャットを始める（カードは残る）
 */
function TalkOption({ snap, card, note, disabled }: { snap: Snapshot; card: Card; note: string; disabled: boolean }) {
  const agents = useAgents().filter((a) => a.available);
  const first = [card.agent, card.delegate].filter((x): x is string => !!x && x !== "me");
  const rank = (id: string) => {
    const i = first.findIndex((f) => profileOf(snap.agents, f).name === profileOf(snap.agents, id).name);
    return i < 0 ? 9 : i;
  };
  const sorted = agents.slice().sort((a, b) => rank(a.id) - rank(b.id));
  const [i, setI] = useState(0);
  const [busy, setBusy] = useState(false);
  if (!sorted.length) return null;
  const agent = sorted[i % sorted.length];
  const p = profileOf(snap.agents, agent.id);
  const start = () => {
    setBusy(true);
    // 送信中の吹き出しを見せながら新しいセッションの画面へ。番号が付いたら、その画面に置き換える
    const sent = submit(agent.id, null, talkText(card, note), []);
    location.hash = `#/session/${agent.id}/new`;
    void sent.then((sid) => sid && location.replace(`#/session/${agent.id}/${encodeURIComponent(sid)}`));
  };
  return (
    <div className="flex min-h-[52px] items-stretch gap-2">
      <button
        onClick={() => setI((x) => (x + 1) % sorted.length)}
        disabled={disabled || busy || sorted.length < 2}
        aria-label={`話す相手を切り替える（いまは${p.name}）`}
        title={sorted.length > 1 ? "押すと話す相手が切り替わる" : undefined}
        className="relative flex size-[52px] flex-none items-center justify-center rounded-full border border-line-2 disabled:cursor-default"
      >
        <Avatar p={p} size={40} />
        {sorted.length > 1 && (
          <span className="absolute -bottom-0.5 -right-0.5 flex size-5 items-center justify-center rounded-full border border-line-2 bg-panel text-[10px] text-ink-2" aria-hidden="true">⇄</span>
        )}
      </button>
      <button
        onClick={start}
        disabled={disabled || busy}
        className="flex min-w-0 flex-1 flex-col items-center justify-center rounded-full border border-line-2 py-1.5 text-[15px] font-bold text-ink disabled:opacity-50"
      >
        {busy ? "始めています…" : `${p.name}と話す`}
        <span className="text-[11px] font-normal opacity-70">この件をチャットで相談する（カードは残る）</span>
      </button>
    </div>
  );
}

const SNOOZES: { id: SnoozeKind; label: string }[] = [
  { id: "3h", label: "3時間" },
  { id: "morning", label: "明日の朝" },
  { id: "week", label: "来週" },
];
const laterOption = (card: Card) => card.options.find((o) => o.id === "later");

/** 控えめな選択肢。「あとで」は長押しで、伏せる長さを選べる */
function QuietOption({ o, first, busy, onChoose, onLong }: { o: CardOption; first: boolean; busy: boolean; onChoose: () => void; onLong?: () => void }) {
  const press = useLongPress(() => onLong?.());
  return (
    <button
      {...(onLong ? press : {})}
      disabled={busy}
      onClick={onChoose}
      className={`gh-nocallout flex flex-1 flex-col items-center justify-center py-1.5 text-[15px] font-bold text-mute disabled:opacity-50 ${first ? "" : "border-l border-line"}`}
    >
      {o.label}
      {o.hint && <span className="text-[11px] font-normal opacity-80">{o.hint}</span>}
    </button>
  );
}

export function CardView({ snap, cardKey }: { snap: Snapshot | null; cardKey: string }) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [sent, setSent] = useState<string | null>(null);
  /** 添付を送っている間の進み具合 */
  const [uploading, setUploading] = useState<{ files: File[]; ratio: number } | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [laterOpen, setLaterOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  /** 押したら、もう判断済みだった */
  const [stale, setStale] = useState(false);

  // 伏せているカードも開ける（並びは判断待ちのあと）
  const cards = [...(snap?.cards ?? []), ...(snap?.snoozed ?? [])];
  const idx = cards.findIndex((c) => c.key === cardKey);
  const card = idx >= 0 ? cards[idx] : null;

  useEffect(() => {
    setText("");
    setFiles([]);
    setSent(null);
    setError(null);
    setDone(null);
    setStale(false);
  }, [cardKey]);

  // 判断のあと次のカードへ移るとき、その時点の一覧で選ぶ（setTimeout の中で古い一覧を見ない）
  const snapRef = useRef(snap);
  snapRef.current = snap;

  const present = !!card;
  useEffect(() => {
    if (present) markSeen(cardKey);
  }, [cardKey, present]);

  const next = () => {
    const rest = (snapRef.current?.cards ?? []).filter((c) => c.key !== cardKey);
    location.hash = rest.length ? `#/card/${encodeURIComponent(rest[0].key)}` : "#/";
  };

  const choose = async (o: CardOption, snooze?: SnoozeKind) => {
    if (o.needsText && !text.trim()) {
      setError("返事を書いてから選んでください");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (files.length) setUploading({ files, ratio: 0 });
      await act(cardKey, o.id, text, files, (ratio) => setUploading({ files, ratio }), snooze);
      setDone(o.label);
      const z = SNOOZES.find((x) => x.id === snooze);
      if (z) toast(`${z.label}まで伏せた`);
      // 「あとで」は伏せたカードの列に移るので、畳まずに取り直すだけ
      if (o.id !== "later") hideCard(cardKey);
      refreshSnapshot();
      setTimeout(next, 700);
    } catch (e) {
      if (e instanceof ActFailed && e.status === 404) {
        // 別の端末・通知のボタンで、もう判断されていた。エラーにせず畳んで次へ
        hideCard(cardKey);
        refreshSnapshot();
        setDone(null);
        setStale(true);
        setTimeout(next, 900);
      } else setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setUploading(null);
    }
  };

  /** 判断せずに前後のカードへ（端まで行ったら反対の端へ）。履歴を積まないので、戻るでカードの列を出られる */
  const canMove = cards.length > 1 && !busy && !done;
  const move = (d: 1 | -1) => {
    if (!canMove || idx < 0) return;
    location.replace(`#/card/${encodeURIComponent(cards[(idx + d + cards.length) % cards.length].key)}`);
  };
  /** 本文の左右を押すと移動。リンクや入力欄・文字を選んでいるとき、書きかけがあるときは動かない */
  const tapSide = (e: MouseEvent<HTMLDivElement>) => {
    if (text.trim() || files.length) return;
    if (e.target instanceof Element && e.target.closest("a, button, input, textarea, label, select")) return;
    if (getSelection()?.toString()) return;
    const box = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - box.left) / box.width;
    if (x < 0.34) move(-1);
    else if (x > 0.66) move(1);
  };
  const moveRef = useRef(move);
  moveRef.current = move;
  // キーボードの ← →
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.target instanceof Element && e.target.closest("input, textarea, select, [contenteditable]")) return;
      if (e.key === "ArrowLeft") moveRef.current(-1);
      else if (e.key === "ArrowRight") moveRef.current(1);
    };
    addEventListener("keydown", on);
    return () => removeEventListener("keydown", on);
  }, []);

  const addFiles = (list: FileList | null) => {
    const picked = Array.from(list ?? []);
    const big = picked.find((f) => f.size > 25 * 1024 * 1024);
    if (big) return setError(`${big.name} は 25MB を超えている`);
    setError(null);
    setFiles((x) => [...x, ...picked].slice(0, 10));
  };

  /** コメント（と添付）だけ送る。カードはそのまま残る。タスクの記録に残り、カンバンのカードならそちらにも */
  const sendComment = async () => {
    if (!text.trim() && !files.length) return;
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("text", text.trim());
      for (const f of files) fd.append("files", f);
      const sending = files;
      if (sending.length) setUploading({ files: sending, ratio: 0 });
      const u = await upload(`/api/cards/${encodeURIComponent(cardKey)}/comment`, fd, (ratio) => setUploading({ files: sending, ratio }));
      if (!u.ok || !u.json.ok) throw new Error(String(u.json.error ?? `HTTP ${u.status}`));
      setSent(files.length ? `コメントと添付 ${files.length} 件を送った（カードは残っている）` : "コメントを送った（カードは残っている）");
      setText("");
      setFiles([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setUploading(null);
    }
  };

  if (!snap) {
    return <AmoebaLoader />;
  }

  if (!card) {
    return (
      <div className="mx-auto flex h-full max-w-[520px] flex-col items-center justify-center gap-4 p-6 text-center">
        <p className="text-mute">{done ? `「${done}」で返しました` : stale ? "このカードは、もう判断済みでした。次へ移ります" : "このカードは判断済みか、もう無くなっています。"}</p>
        {!done && !stale && <NextOrHome snap={snap} />}
      </div>
    );
  }

  const p = profileOf(snap!.agents, card.agent);
  /** 添付はカンバンのカードにだけ付けられる */
  const canAttach = !!card.taskId;
  const main = card.options.filter((o) => o.tone !== "quiet");
  const quiet = card.options.filter((o) => o.tone === "quiet");
  return (
    <div className="mx-auto flex h-full max-w-[520px] flex-col md:max-w-[760px] lg:grid lg:max-w-[1180px] lg:grid-cols-[minmax(0,1fr)_400px] lg:grid-rows-[auto_auto_minmax(0,1fr)] lg:gap-x-10">
      <div className="lg:col-span-2"><Remaining cards={snap.cards} current={card.key} /></div>
      <div className="flex items-center gap-2.5 px-4 py-3 lg:col-span-2">
        <Avatar p={p} size={34} />
        <div className="flex flex-col">
          <div className="text-sm font-bold">{p.name}</div>
          <div className="text-xs text-mute">{ago(card.createdAt)}{card.taskId ? ` · ${card.taskId}` : ""}{card.snoozedUntil ? ` · あとで（${new Date(card.snoozedUntil).getHours()}:${String(new Date(card.snoozedUntil).getMinutes()).padStart(2, "0")} まで伏せ中）` : ""}</div>
        </div>
        <div className="ml-auto flex flex-none items-center">
          {cards.length > 1 && (
            <>
              <button onClick={() => move(-1)} disabled={!canMove} aria-label="前のカードへ（判断はしない）" className="flex size-11 items-center justify-center text-[22px] leading-none text-ink-2 disabled:opacity-30">‹</button>
              <button onClick={() => move(1)} disabled={!canMove} aria-label="次のカードへ（判断はしない）" className="flex size-11 items-center justify-center text-[22px] leading-none text-ink-2 disabled:opacity-30">›</button>
            </>
          )}
          <a href="#/" aria-label="閉じる" className="flex size-11 items-center justify-center"><Icon name="close" /></a>
        </div>
      </div>

      <div onClick={tapSide} className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto overflow-x-hidden px-[22px] pt-4 [overflow-wrap:anywhere] lg:pb-8">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`rounded-full px-3 py-1 text-xs font-bold ${BADGE[card.kind]}`}>{card.statusLabel}</span>
          <span className="flex flex-wrap items-center gap-1.5"><TaskBadges ids={refsIn(card.title, card.body, card.ref ?? "")} /></span>
          {(card.appTaskId ?? card.recordTaskId) && (
            <a
              href={`#/todo/${card.appTaskId ?? card.recordTaskId}`}
              title="タスクを開く（期日・プロジェクト・親子・記録）"
              className="ml-auto flex items-center gap-1 rounded-full border border-line-2 px-3 py-1 font-mono text-xs text-ink-2 no-underline hover:border-ink"
            >
              {card.recordRef ? <CopyRef text={card.recordRef} /> : `#${card.appTaskId ?? card.recordTaskId}`}
              <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
            </a>
          )}
        </div>
        {card.parent && (
          <a href={`#/todo/${card.parent.id}`} className="-mt-2 flex min-w-0 items-center gap-1.5 text-[12.5px] text-mute no-underline hover:text-ink">
            <span className="flex-none">↑</span>
            <span className="flex-none font-mono">{card.parent.ref ? <CopyRef text={card.parent.ref} /> : `#${card.parent.id}`}</span>
            <span className="truncate">{card.parent.title}</span>
            <span className="flex-none">の子</span>
          </a>
        )}
        <h1 className="m-0 text-[26px] font-bold leading-snug">{card.title}</h1>
        {(card.ref || card.url || card.source) && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-ink-2">
            {card.source && <span className="rounded-full bg-chip px-2.5 py-1 font-mono">{SOURCE[card.source] ?? card.source}</span>}
            {card.ref && <span className="rounded-full border border-line px-2.5 py-1 font-mono">{card.ref}</span>}
            {card.url && <a href={card.url} target="_blank" rel="noopener noreferrer" className="rounded-full border border-line-2 px-2.5 py-1 text-blue">開く ↗</a>}
          </div>
        )}
        {card.proposals && card.proposals.length > 0 && (
          <div className="flex flex-col gap-1 rounded-xl border border-lime-line bg-lime-soft px-3 py-2.5 text-[13px]">
            <span className="text-[11px] font-semibold text-lime-ink">{p.name}の提案</span>
            <span className="font-bold">{card.proposals.join(" ／ ")}</span>
          </div>
        )}
        {card.body && (
          <p className={`m-0 whitespace-pre-wrap text-[15px] leading-7 text-ink-2 ${card.kind === "permission" ? "font-mono text-[13px]" : ""}`}>
            {card.body}
          </p>
        )}
      </div>

      {/* 広い画面: 返事と選択肢は右の列（本文を読みながら選べる） */}
      <div className="flex flex-col gap-2.5 p-4 pb-[max(env(safe-area-inset-bottom),18px)] lg:self-start lg:pt-4">
        {error && <div className="rounded-xl bg-orange/10 px-3 py-2 text-sm text-orange-ink" role="alert">{error}</div>}
        {sent && !done && <div className="rounded-xl bg-lime-soft px-3 py-2 text-sm text-lime-ink" role="status">{sent}</div>}
        {uploading && <div className="px-2"><UploadBar ratio={uploading.ratio} files={uploading.files} /></div>}
        {!done && (
          <div className="flex flex-col gap-1.5">
            {files.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {files.map((f, i) => (
                  <span key={`${f.name}${i}`} className="flex max-w-full items-center gap-1 rounded-full border border-line-2 py-1 pl-2.5 pr-1 text-xs">
                    <span className="truncate">{f.name}</span>
                    <button onClick={() => setFiles((x) => x.filter((_, j) => j !== i))} aria-label={`${f.name} を外す`} className="flex size-6 items-center justify-center rounded-full text-mute">×</button>
                  </span>
                ))}
              </div>
            )}
            <div className="flex min-h-[52px] items-center gap-1 rounded-full border border-line-2 pl-1.5 pr-1.5">
              {canAttach && <button onClick={() => picker.current?.click()} aria-label="ファイルを添える" className="flex size-10 flex-none items-center justify-center rounded-full text-mute hover:text-ink">
                <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true"><path d="M21 11.5l-8.6 8.6a5 5 0 01-7.1-7.1l8.6-8.6a3.3 3.3 0 014.7 4.7l-8.6 8.6a1.7 1.7 0 01-2.4-2.4l7.9-7.9" /></svg>
              </button>}
              <input ref={picker} type="file" multiple className="hidden" onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
              <label className="flex min-w-0 flex-1">
                <span className="sr-only">コメント</span>
                <input
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder="コメントを書く…"
                  className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none"
                />
              </label>
              <MicButton onText={(t) => setText((x) => x + t)} />
              {(card.taskId || card.appTaskId || card.recordTaskId) && (
                <button
                  onClick={() => void sendComment()}
                  disabled={busy || (!text.trim() && !files.length)}
                  aria-label="コメントだけ送る（カードは残る）"
                  className="flex size-10 flex-none items-center justify-center rounded-full bg-ink text-paper disabled:opacity-30"
                >
                  <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
                </button>
              )}
            </div>
          </div>
        )}
        {done ? (
          <div className="flex min-h-[52px] items-center justify-center rounded-full bg-lime-soft text-[15px] font-bold text-lime-ink">
            「{done}」で{p.name}に返しました
          </div>
        ) : (
          <>
            {main.map((o) => (
              <button
                key={o.id}
                disabled={busy}
                onClick={() => choose(o)}
                className={`flex min-h-[52px] flex-col items-center justify-center rounded-full border py-1.5 text-[15px] font-bold disabled:opacity-50 ${TONE[o.tone]}`}
              >
                {o.label}
                {o.hint && <span className="text-[11px] font-normal opacity-70">{o.hint}</span>}
              </button>
            ))}
            <TalkOption snap={snap!} card={card} note={text} disabled={busy} />
            {/* 控えめな選択肢（あとで・不要）は、つなげて1本のボタンにする */}
            {quiet.length > 0 && (
              <div className="flex min-h-[52px] overflow-hidden rounded-full border border-line">
                {quiet.map((o, i) => (
                  <QuietOption key={o.id} o={o} first={i === 0} busy={busy} onChoose={() => choose(o)} onLong={o.id === "later" ? () => setLaterOpen(true) : undefined} />
                ))}
              </div>
            )}
            {laterOpen && laterOption(card) && (
              <div className="gh-toast flex gap-2" role="group" aria-label="伏せる長さ">
                {SNOOZES.map((z) => (
                  <button
                    key={z.id}
                    disabled={busy}
                    onClick={() => {
                      setLaterOpen(false);
                      void choose(laterOption(card)!, z.id);
                    }}
                    className="min-h-11 flex-1 rounded-full border border-line-2 text-[13.5px] font-semibold text-ink-2 disabled:opacity-50"
                  >
                    {z.label}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
