// カンバンのカードの詳細（#/task/<ID>）。Hermes のダッシュボードのカードと同じ中身を見て、コメント・ファイルを付けられる。
import { useEffect, useState } from "react";
import type { MediaItem, Snapshot, TaskDetail, TaskRef } from "../shared/types";
import { MediaList } from "./Media";
import { RichText } from "./markdown";
import { Composer } from "./Composer";
import { UploadBar, upload } from "./upload";
import { Avatar, COL, Icon, ago, profileOf } from "./ui";
import { Skeleton } from "./loading";

export const KANBAN_STATUS: Record<string, { label: string; cls: string }> = {
  running: { label: "実行中", cls: "bg-lime-soft text-lime-ink" },
  blocked: { label: "止まっている", cls: "bg-orange-soft text-orange-ink" },
  review: { label: "レビュー待ち", cls: "bg-yellow-soft text-yellow-ink" },
  ready: { label: "待ち", cls: "bg-blue-soft text-blue" },
  todo: { label: "未着手", cls: "bg-blue-soft text-blue" },
  triage: { label: "仕分け待ち", cls: "bg-blue-soft text-blue" },
  scheduled: { label: "予定", cls: "bg-blue-soft text-blue" },
  done: { label: "完了", cls: "bg-chip text-mute" },
  archived: { label: "アーカイブ", cls: "bg-chip text-mute" },
};

const IMAGE_RE = /\.(png|jpe?g|gif|webp|heic|avif)$/i;
const sec = (s: number | null | undefined) => (s ? s * 1000 : 0);
const dur = (a: number, b: number | null) => {
  const s = (b ?? Date.now() / 1000) - a;
  return s < 90 ? `${Math.round(s)}秒` : s < 5400 ? `${Math.round(s / 60)}分` : `${(s / 3600).toFixed(1)}時間`;
};

function Section({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-xs text-mute">
        <span className="font-semibold">{title}</span>
        {right}
      </div>
      {children}
    </section>
  );
}

function Ref({ r, snap }: { r: TaskRef; snap: Snapshot }) {
  return (
    <a href={`#/task/${encodeURIComponent(r.id)}`} className="flex min-h-10 items-center gap-2 rounded-lg border border-line bg-panel px-2.5 text-[13px] text-ink no-underline">
      {r.assignee && <Avatar p={profileOf(snap.agents, r.assignee)} size={20} />}
      <span className="min-w-0 flex-1 truncate">{r.title}</span>
      {r.status && <span className={`rounded-full px-2 py-0.5 text-[10.5px] ${KANBAN_STATUS[r.status]?.cls ?? "bg-chip text-mute"}`}>{KANBAN_STATUS[r.status]?.label ?? r.status}</span>}
    </a>
  );
}

/**
 * 仕分け待ち（triage）のカード。Hermes の「完了」は triage には効かないので、ここで片付ける:
 * 〇〇に任せる（担当を決めて todo に戻し、担当が拾う）／不要（アーカイブ）
 */
function Triage({ id, snap, current, onDone }: { id: string; snap: Snapshot; current: string | null; onDone: (d: TaskDetail) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const agents = snap.agents.filter((a) => a.team !== "watch");
  const post = async (key: string, path: string, body?: object) => {
    setBusy(key);
    setError(null);
    try {
      const r = await fetch(`/api/tasks/${encodeURIComponent(id)}/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
      const b = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; detail?: TaskDetail };
      if (!b.ok) throw new Error(b.error ?? `HTTP ${r.status}`);
      if (b.detail) onDone(b.detail);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Section title="仕分け">
      <div className="flex flex-col gap-3 rounded-xl border border-line bg-panel p-3">
        <div className="text-[12.5px] leading-6 text-ink-2">担当を決めると未着手に戻り、担当のエージェントが拾って動き出す。要らなければアーカイブ。</div>
        <div className="flex flex-wrap gap-2">
          {agents.map((a) => (
            <button
              key={a.id}
              disabled={busy !== null}
              onClick={() => void post(a.id, "specify", { assignee: a.id })}
              className={`flex min-h-11 items-center gap-2 rounded-full border px-3 text-[13px] disabled:opacity-50 ${a.id === current ? "border-ink" : "border-line-2"}`}
            >
              <Avatar p={a} size={22} />
              {busy === a.id ? "任せています…" : `${a.name}に任せる`}
            </button>
          ))}
        </div>
        <button
          disabled={busy !== null}
          onClick={() => void post("archive", "archive")}
          className="min-h-11 self-start rounded-full border border-line-2 px-4 text-[13px] text-mute disabled:opacity-50"
        >
          {busy === "archive" ? "片付けています…" : "不要"}
        </button>
        {error && <div className="rounded-lg bg-orange/10 px-3 py-2 text-xs text-orange-ink" role="alert">{error}</div>}
      </div>
    </Section>
  );
}

export function TaskView({ snap, id }: { snap: Snapshot | null; id: string }) {
  const [d, setD] = useState<TaskDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  /** 添付を送っている間の進み具合（送り終わったら null） */
  const [uploading, setUploading] = useState<{ files: File[]; ratio: number } | null>(null);
  const [showEvents, setShowEvents] = useState(false);
  const eventId = snap?.board?.latest_event_id;

  // カンバンが動いたら（イベント ID が変わったら）読み直す
  useEffect(() => {
    let alive = true;
    fetch(`/api/tasks/${encodeURIComponent(id)}`)
      .then(async (r) => {
        const b = await r.json();
        if (!r.ok) throw new Error(b.error ?? `HTTP ${r.status}`);
        if (alive) (setD(b as TaskDetail), setError(null));
      })
      .catch((e) => alive && setError(String(e.message ?? e)));
    return () => {
      alive = false;
    };
  }, [id, eventId]);

  const send = async (text: string, files: File[]) => {
    setSending(true);
    setSendError(null);
    try {
      let b: { ok?: boolean; error?: string; detail?: TaskDetail };
      let status: number;
      if (files.length) {
        const fd = new FormData();
        fd.append("text", text);
        for (const f of files) fd.append("files", f);
        setUploading({ files, ratio: 0 });
        const u = await upload(`/api/tasks/${encodeURIComponent(id)}/comment`, fd, (ratio) => setUploading({ files, ratio }));
        b = u.json;
        status = u.status;
      } else {
        const r = await fetch(`/api/tasks/${encodeURIComponent(id)}/comment`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
        b = await r.json().catch(() => ({}));
        status = r.status;
      }
      if (!b.ok) throw new Error(b.error ?? `HTTP ${status}`);
      if (b.detail) setD(b.detail);
    } catch (e) {
      setSendError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
      setUploading(null);
    }
  };

  const t = d?.task;
  const who = (a: string | null | undefined) => (snap ? profileOf(snap.agents, a === "owner" ? "me" : (a ?? "unassigned")) : null);
  const assignee = t && who(t.assignee);
  const card = snap?.cards.find((c) => c.taskId === id);
  const [owner, setOwner] = useState<{ id: number; ref: string | null } | null>(null);
  useEffect(() => {
    setOwner(null);
    void fetch(`/api/apptasks-by-kanban/${encodeURIComponent(id)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((t: { id: number; ref: string | null } | null) => setOwner(t))
      .catch(() => {});
  }, [id]);
  const files: MediaItem[] = (d?.attachments ?? []).map((a) => ({
    name: a.name,
    url: `/api/media/hermes?path=${encodeURIComponent(a.path)}`,
    kind: IMAGE_RE.test(a.name) ? "image" : /\.pdf$/i.test(a.name) ? "pdf" : "file",
    size: a.size,
  }));

  return (
    <div className={`${COL} flex h-full min-w-0 flex-col lg:max-w-[1320px]`}>
      <div className="flex items-center gap-2.5 px-4 pb-2 pt-[max(env(safe-area-inset-top),14px)]">
        <button onClick={() => (history.length > 1 ? history.back() : (location.hash = "#/watching"))} aria-label="戻る" className="flex size-11 items-center justify-center text-[20px]">‹</button>
        {assignee && <Avatar p={assignee} size={30} />}
        <div className="flex min-w-0 flex-col">
          <div className="text-sm font-bold">{assignee?.name ?? "未割り当て"}</div>
          <div className="truncate font-mono text-[11px] text-mute">{id}{t ? ` · 作成 ${ago(sec(t.created_at))}${t.created_by ? `（${who(t.created_by)?.name ?? t.created_by}）` : ""}` : ""}</div>
        </div>
        <a href="#/watching" aria-label="閉じる" className="ml-auto flex size-11 items-center justify-center"><Icon name="close" /></a>
      </div>

      {owner && <a href={`#/todo/${owner.id}`} className="mx-4 mb-1 flex items-center gap-2 rounded-lg bg-chip px-3 py-2 text-[12.5px] text-ink-2 no-underline">タスク {owner.ref ?? `#${owner.id}`} の実行記録です <span className="ml-auto">タスクを開く ›</span></a>}
      {/* 長い URL などの切れ目の無い文字列も折り返す。横にはみ出すと画面ごと横にずれる */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-5 overflow-y-auto overflow-x-hidden px-[18px] pb-4 pt-2 [overflow-wrap:anywhere]">
        {error && <div className="rounded-xl bg-orange/10 px-3 py-2 text-xs text-orange-ink" role="alert">{error}</div>}
        {!d && !error && <Skeleton />}
        {t && snap && (
          <div className="flex flex-col gap-5 lg:grid lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start lg:gap-10">
          <div className="flex min-w-0 flex-col gap-5">
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded-full px-3 py-1 text-xs font-bold ${KANBAN_STATUS[t.status]?.cls ?? "bg-chip text-mute"}`}>{KANBAN_STATUS[t.status]?.label ?? t.status}</span>
                {t.priority > 0 && <span className="rounded-full border border-line-2 px-2.5 py-0.5 text-[11px]">優先 {t.priority}</span>}
                {(t.skills ?? []).map((s) => <span key={s} className="rounded-full border border-line px-2.5 py-0.5 font-mono text-[11px] text-ink-2">{s}</span>)}
                {card && <a href={`#/card/${encodeURIComponent(card.key)}`} className="ml-auto rounded-full bg-ink px-3 py-1 text-xs font-bold text-paper no-underline">判断する</a>}
              </div>
              <h1 className="m-0 text-[22px] font-bold leading-snug">{t.title}</h1>
              <div className="text-[11px] text-mute">
                {t.started_at ? `着手 ${ago(sec(t.started_at))}` : "未着手"}
                {t.completed_at ? ` · 完了 ${ago(sec(t.completed_at))}` : ""}
                {t.model_override ? ` · ${t.provider_override ?? ""} ${t.model_override}` : ""}
              </div>
            </div>

            {t.status === "triage" && <Triage id={id} snap={snap} current={t.assignee} onDone={setD} />}

            {t.body && (
              <Section title="本文">
                <div className="text-[14px] leading-7 text-ink-2"><RichText text={t.body} /></div>
              </Section>
            )}

            {(t.result || d!.latest_summary) && (
              <Section title="結果">
                <div className="rounded-xl border border-lime-line bg-lime-soft/40 p-3 text-[13.5px] leading-6"><RichText text={t.result || d!.latest_summary || ""} /></div>
              </Section>
            )}
            {t.last_failure_error && (
              <Section title="直近の失敗">
                <pre className="m-0 whitespace-pre-wrap break-words rounded-xl bg-red-soft p-3 font-mono text-[11.5px] text-red-ink">{t.last_failure_error}</pre>
              </Section>
            )}

            <Section
              title={`コメント ${d!.comments.length}`}
              right={
                d!.events.length > 0 && (
                  <button onClick={() => setShowEvents((x) => !x)} className="ml-auto rounded-full border border-line-2 px-2.5 py-0.5 text-[11px]">
                    履歴 {d!.events.length} 件を{showEvents ? "隠す" : "見る"}
                  </button>
                )
              }
            >
              {showEvents && (
                <ol className="m-0 flex list-none flex-col gap-1 rounded-xl border border-line bg-panel-2 p-2.5 font-mono text-[11px] text-mute">
                  {d!.events.map((e, i) => (
                    <li key={i} className="flex flex-col">
                      <span><span className="text-ink-2">{e.kind}</span> · {ago(sec(e.created_at))}</span>
                      {e.detail && <span className="truncate">{e.detail}</span>}
                    </li>
                  ))}
                </ol>
              )}
              {d!.comments.length === 0 && <div className="text-[12.5px] text-mute">まだコメントはない</div>}
              {d!.comments.map((c, i) => {
                const p = who(c.author);
                const mine = c.author === "owner";
                return (
                  <div key={i} className={`flex gap-2 ${mine ? "flex-row-reverse" : ""}`}>
                    {p && <Avatar p={p} size={26} />}
                    <div className={`flex min-w-0 max-w-[85%] flex-col gap-0.5 rounded-xl px-3 py-2 text-[13px] leading-6 ${mine ? "bg-ink text-paper" : "border border-line bg-panel"}`}>
                      <span className={`text-[10.5px] ${mine ? "opacity-70" : "text-mute"}`}>{p?.name ?? c.author} · {ago(sec(c.created_at))}</span>
                      <div className="break-words"><RichText text={c.body} /></div>
                    </div>
                  </div>
                );
              })}
            </Section>
          </div>
          {/* 広い画面では右の列。スマホではコメントの下 */}
          <aside className="flex min-w-0 flex-col gap-5">
              {files.length > 0 && (
                <Section title={`添付 ${files.length}`}>
                  <MediaList items={files} />
                </Section>
              )}

              {(d!.parents.length > 0 || d!.children.length > 0) && (
                <Section title="つながり">
                  {d!.parents.length > 0 && <div className="text-[11px] text-mute">上流（これを待っている元）</div>}
                  {d!.parents.map((r) => <Ref key={r.id} r={r} snap={snap} />)}
                  {d!.children.length > 0 && <div className="text-[11px] text-mute">下流（このあとに続く）</div>}
                  {d!.children.map((r) => <Ref key={r.id} r={r} snap={snap} />)}
                </Section>
              )}

              {d!.runs.length > 0 && (
                <Section title={`実行 ${d!.runs.length}`}>
                  {d!.runs.slice().reverse().map((r) => (
                    <div key={r.id} className="flex flex-col gap-1 rounded-xl border border-line bg-panel p-2.5 text-[12px]">
                      <div className="flex items-center gap-2">
                        {r.profile && <Avatar p={profileOf(snap.agents, r.profile)} size={18} />}
                        <span className="font-semibold">{r.outcome ?? r.status}</span>
                        <span className="ml-auto font-mono text-[10.5px] text-mute">{ago(sec(r.started_at))} · {dur(r.started_at, r.ended_at)}</span>
                      </div>
                      {r.summary && <div className="text-ink-2"><RichText text={r.summary} /></div>}
                      {r.error && <pre className="m-0 whitespace-pre-wrap break-words font-mono text-[11px] text-red-ink">{r.error}</pre>}
                    </div>
                  ))}
                </Section>
              )}
          </aside>
          </div>
        )}
      </div>

      {t && (
        <div className="border-t border-line p-2.5 pb-[max(env(safe-area-inset-bottom),10px)]">
          {sendError && <div className="mb-2 rounded-xl bg-orange/10 px-3 py-2 text-xs text-orange-ink" role="alert">送れなかった: {sendError}</div>}
          {uploading && <div className="mb-2 px-1"><UploadBar ratio={uploading.ratio} files={uploading.files} /></div>}
          <Composer placeholder={sending ? "送っている…" : "コメントを書く…"} busy={sending} draftKey={`task:${id}`} onSend={(text, f) => void send(text, f)} />
        </div>
      )}
    </div>
  );
}
