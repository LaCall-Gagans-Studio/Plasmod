// 持ち主のプロフィールカード。アーチ形の窓に色と顔、大きな名前、等幅の肩書き、使い始めの札。
// 押すと裏で編集できる。エージェントは選手紹介のカード（AgentSquad）のまま。
import { useState } from "react";
import { inkOn } from "./AgentSquad";
import { t } from "./i18n";
import { getAbout, loadAbout, saveOwner, useAbout } from "./identity";

const fmtDay = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
};

/** 円に沿って文字を回すスタンプ。使い始めてからの日数 */
function Stamp({ days, color }: { days: number; color: string }) {
  return (
    <svg width={62} height={62} viewBox="0 0 100 100" role="img" aria-label={`${days} ${t("日目")}`} className="flex-none -rotate-12">
      <circle cx="50" cy="50" r="47" fill="none" stroke={color} strokeWidth="3" />
      <circle cx="50" cy="50" r="30" fill="none" stroke={color} strokeWidth="2" />
      <path id="pl-stamp" d="M50 50 m-38 0 a38 38 0 1 1 76 0 a38 38 0 1 1 -76 0" fill="none" />
      <text fontSize="11.5" fontWeight="700" letterSpacing="2.6" fill={color}>
        <textPath href="#pl-stamp">PLASMOD · ACTIVE DAYS · </textPath>
      </text>
      <text x="50" y="59" textAnchor="middle" fontSize={days > 999 ? 18 : 26} fontWeight="800" fill={color}>{days}</text>
    </svg>
  );
}

export function ProfileCard() {
  const about = useAbout();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const color = about.ownerColor ?? "#C97A1E";
  const title = about.ownerTitle ?? "";
  const joined = about.joinedAt ?? Date.now();
  const days = Math.max(1, Math.floor((Date.now() - joined) / 86_400_000) + 1);
  const hasName = !about.ownerIsDefault;

  const patch = async (body: Record<string, unknown>) => {
    setError(null);
    const r = await fetch("/api/about", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) setError(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${r.status}`);
    await loadAbout();
  };
  const upload = async (f: File | undefined) => {
    if (!f) return;
    const fd = new FormData();
    fd.append("file", f);
    const r = await fetch("/api/about/avatar", { method: "POST", body: fd });
    if (!r.ok) setError(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${r.status}`);
    await loadAbout();
  };
  const field = "min-h-9 min-w-0 flex-1 rounded-lg border border-line-2 bg-transparent px-2.5 text-[13px] outline-none";

  return (
    <section aria-label={t("プロフィール")} className="mx-4 flex flex-col gap-2.5">
      <div className="flex justify-center rounded-2xl p-5" style={{ background: `radial-gradient(circle at 50% 42%, color-mix(in srgb, ${color} 92%, #000), color-mix(in srgb, ${color} 62%, #fff))` }}>
        <button onClick={() => setEditing((x) => !x)} aria-expanded={editing} aria-label={t("プロフィールを編集する")} className="flex w-full max-w-[300px] flex-col rounded-2xl bg-[#FFFDEB] p-4 text-left shadow-[0_14px_40px_rgba(0,0,0,0.22)]" style={{ color: `color-mix(in srgb, ${color} 72%, #000)` }}>
          {/* アーチ形の窓 */}
          <span
            className="relative flex aspect-[1/0.92] w-full items-center justify-center overflow-hidden rounded-b-md rounded-t-[999px]"
            style={{ background: `radial-gradient(circle at 30% 18%, color-mix(in srgb, ${color} 72%, #fff), ${color} 48%, color-mix(in srgb, ${color} 72%, #000))` }}
          >
            {about.ownerAvatar ? (
              <img src={about.ownerAvatar} alt="" className="absolute inset-0 size-full object-cover" draggable={false} />
            ) : (
              <span className="text-[72px] font-black leading-none" style={{ color: inkOn(color), opacity: 0.86 }}>{[...about.owner][0] ?? "?"}</span>
            )}
          </span>
          <span className="mt-4 truncate text-[32px] font-black leading-tight tracking-tight">{hasName ? about.owner : t("あなたの名前")}</span>
          <span className="min-h-[1.4em] truncate font-mono text-[14px] tracking-wide">{title || t("肩書きを足す")}</span>
          <span className="mt-4 flex items-end justify-between gap-2">
            <span className="flex flex-col items-start gap-1.5">
              <Stamp days={days} color="#3A3AF0" />
              <span className="flex h-6 items-stretch overflow-hidden rounded border-[1.5px] border-current text-[10.5px] font-bold">
                <span className="flex items-center px-1.5">PLASMOD</span>
                <span aria-hidden="true" className="w-3.5 border-x-[1.5px] border-current" style={{ background: "repeating-linear-gradient(-45deg, currentColor 0 1px, transparent 1px 3px)" }} />
                <span className="flex items-center px-1.5 tabular-nums">{fmtDay(joined)}</span>
              </span>
            </span>
            <span className="text-right font-serif text-[12px] font-semibold leading-tight">SO<br />ELECTRIC</span>
          </span>
        </button>
      </div>
      {error && <div className="text-[12px] text-orange-ink" role="alert">{error}</div>}
      {editing && (
        <div className="flex flex-col gap-2 rounded-xl border border-line bg-panel p-3 text-[13px]">
          <label className="flex items-center gap-3">
            <span className="w-14 flex-none text-[12px] text-mute">{t("呼び名")}</span>
            <input key={`o:${getAbout().owner}`} defaultValue={hasName ? about.owner : ""} maxLength={40} onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== about.owner && void saveOwner(e.target.value.trim()).catch((x) => setError(String(x.message ?? x)))} aria-label={t("あなたの呼び名")} className={field} />
          </label>
          <label className="flex items-center gap-3">
            <span className="w-14 flex-none text-[12px] text-mute">{t("肩書き")}</span>
            <input key={`t:${title}`} defaultValue={title} maxLength={40} placeholder="Breezy Operator" onBlur={(e) => e.target.value.trim() !== title && void patch({ title: e.target.value })} aria-label={t("肩書き")} className={field} />
          </label>
          <label className="flex items-center gap-3">
            <span className="w-14 flex-none text-[12px] text-mute">{t("色")}</span>
            <input type="color" defaultValue={color} onBlur={(e) => e.target.value !== color && void patch({ color: e.target.value })} aria-label={t("色")} className="size-9 flex-none cursor-pointer rounded-lg border border-line-2 bg-transparent p-1" />
          </label>
          <label className="flex items-center gap-3">
            <span className="w-14 flex-none text-[12px] text-mute">{t("顔")}</span>
            <span className="flex min-h-9 flex-1 cursor-pointer items-center rounded-lg border border-line-2 px-2.5 text-[12.5px] text-ink-2">
              {t("画像を選ぶ（PNG・JPEG・WebP）")}
              <input type="file" accept="image/png,image/jpeg,image/webp" aria-label={t("顔")} className="sr-only" onChange={(e) => void upload(e.target.files?.[0])} />
            </span>
            {about.ownerAvatar && <button onClick={() => void patch({ avatar: null })} className="min-h-9 flex-none rounded-lg border border-line-2 px-2.5 text-[12px] text-ink-2">{t("外す")}</button>}
          </label>
        </div>
      )}
    </section>
  );
}
