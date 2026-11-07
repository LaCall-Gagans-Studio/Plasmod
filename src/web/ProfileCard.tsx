// 持ち主のプロフィールカード。標本の図版のように、黒地に発光する線で描く。
// アーチ形の窓の中に、名前から決まる形のアメーバ（目玉、節の連なり、節から伸びる細い触手）がいる。
// 押すと編集できる。エージェントは選手紹介のカード（AgentSquad）のまま。
import { useState } from "react";
import { blobPath } from "./amoeba";
import { t } from "./i18n";
import { getAbout, loadAbout, saveOwner, useAbout } from "./identity";

const fmtDay = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
};

/** 名前から決まる乱数（同じ名前なら毎回同じ形） */
function seeded(text: string) {
  let h = 2166136261;
  for (const c of text) h = Math.imul(h ^ c.codePointAt(0)!, 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507) ^ Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

const W = 300;
const H = 290;

/** 標本の図: 体（目玉）から節が弧を描いて連なり、節ごとに細い触手が枝分かれして、先に点がつく */
function Specimen({ seed, color, avatar }: { seed: string; color: string; avatar?: string }) {
  const r = seeded(seed || "plasmod");
  const head: [number, number] = [W * 0.67, H * 0.71];
  const radii = Array.from({ length: 14 }, () => 27 + r() * 9);
  const segs: { x: number; y: number; deg: number }[] = [];
  let x = head[0];
  let y = head[1];
  let dir = -2.7 - r() * 0.3;
  const bend = 0.17 + r() * 0.06;
  x += 34 * Math.cos(dir);
  y += 34 * Math.sin(dir);
  for (let i = 0; i < 11; i++) {
    segs.push({ x, y, deg: (dir * 180) / Math.PI });
    dir += bend;
    x += 18 * Math.cos(dir);
    y += 18 * Math.sin(dir);
  }
  const wires: { d: string; tips: [number, number][] }[] = [];
  segs.forEach((g, i) => {
    for (const side of [-1, 1]) {
      const pts: [number, number][] = [[g.x, g.y]];
      let a = (g.deg * Math.PI) / 180 + side * (1.25 + r() * 0.5);
      let px = g.x;
      let py = g.y;
      const n = 2 + Math.floor(r() * 2);
      for (let k = 0; k < n; k++) {
        const len = 18 + r() * 26;
        px += len * Math.cos(a);
        py += len * Math.sin(a);
        pts.push([px, py]);
        a += (r() - 0.5) * 1.1;
      }
      wires.push({ d: pts.map((p, k) => `${k ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(""), tips: pts.slice(1) });
      // 途中から細い枝
      if (i % 2 === 0) {
        const b = pts[1];
        const c: [number, number] = [b[0] + 14 * Math.cos(a + 1) + 6, b[1] + 14 * Math.sin(a + 1)];
        wires.push({ d: `M${b[0].toFixed(1)},${b[1].toFixed(1)}L${c[0].toFixed(1)},${c[1].toFixed(1)}`, tips: [c] });
      }
    }
  });
  // 図のあちこちの、読み取りが乱れたようなかけら
  const shards = Array.from({ length: 7 }, () => ({ x: r() * W, y: r() * H, w: 6 + r() * 26, h: 1.5 + r() * 3, o: 0.25 + r() * 0.5 }));
  const clip = `pl-av-${[...seed].reduce((a, c) => a + c.codePointAt(0)!, 0)}`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="absolute inset-0 size-full" aria-hidden="true">
      {shards.map((s, i) => <rect key={i} x={s.x} y={s.y} width={s.w} height={s.h} fill="#fff" opacity={s.o * 0.5} />)}
      <g fill="none" stroke={color} strokeWidth="0.9" opacity="0.8">
        {wires.map((w, i) => <path key={i} d={w.d} />)}
      </g>
      <g fill="#F4FF9A">
        {wires.flatMap((w, i) => w.tips.map((p, k) => <circle key={`${i}-${k}`} cx={p[0]} cy={p[1]} r={k === w.tips.length - 1 ? 1.9 : 1.1} />))}
      </g>
      {/* 節: 光る枠の四角が連なる */}
      {segs.map((g, i) => (
        <g key={i} transform={`translate(${g.x.toFixed(1)} ${g.y.toFixed(1)}) rotate(${g.deg.toFixed(1)})`}>
          <rect x="-8" y="-11" width="16" height="22" fill={i % 3 === 0 ? color : "#07080A"} fillOpacity={i % 3 === 0 ? 0.92 : 1} stroke="#E9FF6B" strokeWidth="1.1" className="pl-seg" style={{ animationDelay: `${i * 0.28}s` }} />
          <path d="M-8,0H8M0,-11V11" stroke={i % 3 === 0 ? "#07080A" : "#E9FF6B"} strokeWidth="0.9" />
        </g>
      ))}
      {/* 体と目玉 */}
      <path d={blobPath(head[0], head[1], radii)} fill={color} style={{ filter: `drop-shadow(0 0 7px ${color})` }} />
      {avatar ? (
        <>
          <clipPath id={clip}><circle cx={head[0]} cy={head[1]} r="20" /></clipPath>
          <image href={avatar} x={head[0] - 20} y={head[1] - 20} width="40" height="40" clipPath={`url(#${clip})`} preserveAspectRatio="xMidYMid slice" />
          <circle cx={head[0]} cy={head[1]} r="20" fill="none" stroke="#07080A" strokeWidth="1.5" />
        </>
      ) : (
        <>
          <circle cx={head[0]} cy={head[1]} r="17" fill="#F3F1EC" />
          <circle cx={head[0] + 3} cy={head[1] + 1} r="10" fill="#07080A" />
          <circle cx={head[0]} cy={head[1] - 4} r="3" fill="#fff" />
        </>
      )}
    </svg>
  );
}

/** 円に沿って文字を回すスタンプ。使い続けた日数 */
function Stamp({ days, color }: { days: number; color: string }) {
  return (
    <svg width={58} height={58} viewBox="0 0 100 100" role="img" aria-label={`${days} ${t("日目")}`} className="flex-none -rotate-12">
      <circle cx="50" cy="50" r="47" fill="none" stroke={color} strokeWidth="2.5" />
      <circle cx="50" cy="50" r="30" fill="none" stroke={color} strokeWidth="1.5" />
      <path id="pl-stamp" d="M50 50 m-38 0 a38 38 0 1 1 76 0 a38 38 0 1 1 -76 0" fill="none" />
      <text fontSize="11.5" fontWeight="700" letterSpacing="2.6" fill={color} fontFamily="monospace">
        <textPath href="#pl-stamp">PLASMOD · ACTIVE DAYS · </textPath>
      </text>
      <text x="50" y="59" textAnchor="middle" fontSize={days > 999 ? 18 : 26} fontWeight="800" fill={color} fontFamily="monospace">{days}</text>
    </svg>
  );
}

export function ProfileCard() {
  const about = useAbout();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const color = about.ownerColor ?? "#C8F25A";
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
      <div className="flex justify-center rounded-2xl p-4" style={{ background: `radial-gradient(circle at 50% 38%, color-mix(in srgb, ${color} 24%, #07080A), #07080A 72%)` }}>
        <button onClick={() => setEditing((x) => !x)} aria-expanded={editing} aria-label={t("プロフィールを編集する")} className="flex w-full max-w-[310px] flex-col border bg-[#07080A] p-3.5 text-left font-mono text-[#E8E8E2]" style={{ borderColor: `color-mix(in srgb, ${color} 60%, transparent)`, boxShadow: `0 0 26px color-mix(in srgb, ${color} 22%, transparent)` }}>
          <span className="mb-2.5 flex justify-between text-[9.5px] tracking-[0.14em] opacity-70">
            <span>PLASMODIUM SP.</span>
            <span>PLATE {String(days).padStart(4, "0")}</span>
          </span>
          {/* アーチ形の窓 */}
          <span className="relative block aspect-[300/290] w-full overflow-hidden rounded-t-[999px] border" style={{ borderColor: color }}>
            <Specimen seed={about.owner} color={color} avatar={about.ownerAvatar} />
          </span>
          <span className="mt-3.5 truncate font-sans text-[30px] font-black leading-tight tracking-tight text-white">{hasName ? about.owner : t("あなたの名前")}</span>
          <span className="min-h-[1.4em] truncate text-[13px] tracking-wide" style={{ color }}>
            {title || t("肩書きを足す")}
          </span>
          <span aria-hidden="true" className="mt-2 flex h-[5px] w-2/3 gap-[2px]">
            {Array.from({ length: 22 }, (_, i) => <span key={i} className="flex-1" style={{ background: color, opacity: ((i * 7) % 11) / 11 + 0.12 }} />)}
          </span>
          <span className="mt-3 flex items-end justify-between gap-2">
            <span className="flex flex-col items-start gap-1.5">
              <Stamp days={days} color={color} />
              <span className="flex h-6 items-stretch border text-[10px] font-bold" style={{ borderColor: color, color }}>
                <span className="flex items-center px-1.5">PLASMOD</span>
                <span aria-hidden="true" className="w-3.5 border-x" style={{ borderColor: color, background: `repeating-linear-gradient(-45deg, ${color} 0 1px, transparent 1px 3px)` }} />
                <span className="flex items-center px-1.5 tabular-nums">{fmtDay(joined)}</span>
              </span>
            </span>
            <span className="text-right text-[11px] font-bold leading-tight tracking-[0.12em]" style={{ color }}>SO<br />ELECTRIC</span>
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
