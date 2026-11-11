// 持ち主のプロフィールカード。標本の図版のように、黒地に発光する線で描く。
// アーチ形の窓の中を、名前から形が決まる生き物が這い回る。長押しでメニュー（編集・画像で保存）。
// エージェントは選手紹介のカード（AgentSquad）のまま。
import { useEffect, useMemo, useRef, useState } from "react";
import { blobPath } from "./amoeba";
import { t } from "./i18n";
import { loadAbout, saveOwner, useAbout } from "./identity";
import { DangerButton, Glyph, Sheet, SheetCard, TileButton, Tiles } from "./sheet";
import { cardSvg, fmtTokens, H, makeCreature, segAngle, step, W, wirePath, wirePoints } from "./specimen";
import { toast, useLongPress } from "./touch";

const fmtDay = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
};

/** 枠の中を動く生き物 */
function Specimen({ seed, tokens, color, avatar, svgRef }: { seed: string; tokens: number; color: string; avatar?: string; svgRef: React.RefObject<SVGSVGElement | null> }) {
  const c = useMemo(() => makeCreature(seed, tokens), [seed, tokens]);
  const clip = useMemo(() => `pl-av-${Math.random().toString(36).slice(2, 8)}`, []);
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const body = svg.querySelector<SVGGElement>("[data-body]")!;
    const blob = svg.querySelector<SVGPathElement>("[data-blob]")!;
    const pupil = svg.querySelector<SVGGElement>("[data-pupil]");
    const lid = svg.querySelector<SVGGElement>("[data-lid]");
    const segEls = [...svg.querySelectorAll<SVGGElement>("[data-seg]")];
    const wireEls = [...svg.querySelectorAll<SVGPathElement>("[data-wire]")];
    const tipEls = [...svg.querySelectorAll<SVGCircleElement>("[data-tip]")];
    let raf = 0;
    let visible = true;
    let last = performance.now();
    let drawn = 0;
    let blinkAt = last + 2500;
    const io = new IntersectionObserver((e) => (visible = e.some((x) => x.isIntersecting)));
    io.observe(svg);
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (!visible || document.hidden || now - drawn < 33) {
        if (!visible || document.hidden) last = now;
        return;
      }
      drawn = now;
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const time = now / 1000;
      step(c, dt, time);
      body.setAttribute("transform", `translate(${c.x.toFixed(1)} ${c.y.toFixed(1)})`);
      blob.setAttribute("d", blobPath(0, 0, c.radii.map((r, i) => r + 2.4 * Math.sin(time * 1.6 + i * 1.3)), c.dir));
      // 進むほうを見る
      pupil?.setAttribute("transform", `translate(${(Math.cos(c.dir) * 5).toFixed(1)} ${(Math.sin(c.dir) * 5).toFixed(1)})`);
      if (now > blinkAt + 170) blinkAt = now + 2200 + Math.random() * 3800;
      const blink = now > blinkAt ? Math.sin(((now - blinkAt) / 170) * Math.PI) : 0;
      lid?.setAttribute("transform", `scale(1 ${(1 - 0.92 * blink).toFixed(2)})`);
      segEls.forEach((el, i) => el.setAttribute("transform", `translate(${c.segs[i][0].toFixed(1)} ${c.segs[i][1].toFixed(1)}) rotate(${((segAngle(c, i) * 180) / Math.PI).toFixed(1)})`));
      let tip = 0;
      c.wires.forEach((w, i) => {
        const pts = wirePoints(c, w, time);
        wireEls[i].setAttribute("d", wirePath(pts));
        for (let k = 1; k < pts.length; k++, tip++) {
          tipEls[tip].setAttribute("cx", pts[k][0].toFixed(1));
          tipEls[tip].setAttribute("cy", pts[k][1].toFixed(1));
        }
      });
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
    };
  }, [c, svgRef]);

  const pts = c.wires.map((w) => wirePoints(c, w, 0));
  return (
    <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="absolute inset-0 size-full" aria-hidden="true">
      {c.shards.map((s, i) => <rect key={i} x={s.x} y={s.y} width={s.w} height={s.h} fill="#fff" opacity={s.o} />)}
      <g fill="none" stroke={color} strokeWidth="0.9" opacity="0.8">
        {pts.map((p, i) => <path key={i} data-wire="" d={wirePath(p)} />)}
      </g>
      <g fill="#F4FF9A">
        {pts.flatMap((p, i) => p.slice(1).map((q, k) => <circle key={`${i}-${k}`} data-tip="" cx={q[0]} cy={q[1]} r={k === p.length - 2 ? 1.9 : 1.1} />))}
      </g>
      {c.segs.map((s, i) => (
        <g key={i} data-seg="" transform={`translate(${s[0].toFixed(1)} ${s[1].toFixed(1)}) rotate(${((segAngle(c, i) * 180) / Math.PI).toFixed(1)})`}>
          <rect x="-8" y="-11" width="16" height="22" fill={i % 3 === 0 ? color : "#07080A"} fillOpacity={i % 3 === 0 ? 0.92 : 1} stroke="#E9FF6B" strokeWidth="1.1" className="pl-seg" style={{ animationDelay: `${i * 0.28}s` }} />
          <path d="M-8,0H8M0,-11V11" stroke={i % 3 === 0 ? "#07080A" : "#E9FF6B"} strokeWidth="0.9" />
        </g>
      ))}
      <g data-body="" transform={`translate(${c.x.toFixed(1)} ${c.y.toFixed(1)})`}>
        <path data-blob="" d={blobPath(0, 0, c.radii, c.dir)} fill={color} style={{ filter: `drop-shadow(0 0 7px ${color})` }} />
        {avatar ? (
          <>
            <clipPath id={clip}><circle r="20" /></clipPath>
            <image href={avatar} x="-20" y="-20" width="40" height="40" clipPath={`url(#${clip})`} preserveAspectRatio="xMidYMid slice" />
            <circle r="20" fill="none" stroke="#07080A" strokeWidth="1.5" />
          </>
        ) : (
          <g data-lid="">
            <circle r="17" fill="#F3F1EC" />
            <g data-pupil="">
              <circle r="10" fill="#07080A" />
              <circle cx="-3" cy="-4" r="3" fill="#fff" />
            </g>
          </g>
        )}
      </g>
    </svg>
  );
}

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

const toDataUrl = async (url: string) => {
  const b = await (await fetch(url)).blob();
  return new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(new Error("画像を読めない"));
    r.readAsDataURL(b);
  });
};

/** SVG を PNG にする */
export function svgToPng(svg: string, width: number, height: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = width;
      c.height = height;
      c.getContext("2d")!.drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(url);
      c.toBlob((b) => (b ? resolve(b) : reject(new Error("画像にできなかった"))), "image/png");
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("画像にできなかった"));
    };
    img.src = url;
  });
}

/** 保存する。APK の WebView は blob を保存できないので、サーバーに預けて、その URL を保存する */
async function saveBlob(b: Blob, name: string) {
  if (/; wv\)/.test(navigator.userAgent)) {
    const r = await fetch("/api/about/card-image", { method: "POST", headers: { "Content-Type": "image/png" }, body: b });
    const j = (await r.json().catch(() => ({}))) as { id?: string; error?: string };
    if (!r.ok || !j.id) throw new Error(j.error ?? `HTTP ${r.status}`);
    location.assign(`/api/about/card-image/${j.id}`);
    return;
  }
  const url = URL.createObjectURL(b);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function ProfileCard() {
  const about = useAbout();
  const [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const color = about.ownerColor ?? "#C8F25A";
  const title = about.ownerTitle ?? "";
  const joined = about.joinedAt ?? Date.now();
  const days = Math.max(1, Math.floor((Date.now() - joined) / 86_400_000) + 1);
  const hasName = !about.ownerIsDefault;
  const [tokens, setTokens] = useState(0);
  useEffect(() => {
    fetch("/api/system/tokens-total").then((r) => r.json()).then((j: { tokens?: number }) => setTokens(Number(j.tokens) || 0)).catch(() => {});
  }, []);
  const press = useLongPress(() => setMenu(true));

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
  const download = async () => {
    if (!svgRef.current) return;
    setBusy(true);
    setError(null);
    try {
      let specimen = svgRef.current.innerHTML;
      if (about.ownerAvatar) specimen = specimen.split(about.ownerAvatar).join(await toDataUrl(about.ownerAvatar));
      const svg = cardSvg({ specimen, name: hasName ? about.owner : "", title, color, days, joined: fmtDay(joined), tokens });
      await saveBlob(await svgToPng(svg, 1240, 1800), "plasmod-card.png");
      toast(t("カードを保存した"));
      setMenu(false);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };
  const field = "min-h-10 min-w-0 flex-1 rounded-xl bg-chip/70 px-3 text-[14px] outline-none focus:bg-chip";

  return (
    <section aria-label={t("プロフィール")} className="mx-4">
      <div className="flex justify-center rounded-2xl p-4" style={{ background: `radial-gradient(circle at 50% 38%, color-mix(in srgb, ${color} 24%, #07080A), #07080A 72%)` }}>
        <div {...press} role="button" tabIndex={0} aria-label={t("長押しでメニュー")} onKeyDown={(e) => e.key === "Enter" && setMenu(true)} className="gh-nocallout flex w-full max-w-[310px] cursor-pointer select-none flex-col border bg-[#07080A] p-3.5 text-left font-mono text-[#E8E8E2] [-webkit-touch-callout:none]" style={{ borderColor: `color-mix(in srgb, ${color} 60%, transparent)`, boxShadow: `0 0 26px color-mix(in srgb, ${color} 22%, transparent)` }}>
          <span className="mb-2.5 flex justify-between text-[9.5px] tracking-[0.14em] opacity-70">
            <span>PLASMODIUM SP.</span>
            <span>PLATE {String(days).padStart(4, "0")}</span>
          </span>
          <span className="relative block aspect-[300/290] w-full overflow-hidden rounded-t-[999px] border" style={{ borderColor: color }}>
            <Specimen key={`${about.owner}:${tokens}`} seed={about.owner} tokens={tokens} color={color} avatar={about.ownerAvatar} svgRef={svgRef} />
          </span>
          <span className="mt-3.5 truncate font-sans text-[30px] font-black leading-tight tracking-tight text-white">{hasName ? about.owner : t("あなたの名前")}</span>
          <span className="min-h-[1.4em] truncate text-[13px] tracking-wide" style={{ color }}>{title || t("長押しで肩書きを足す")}</span>
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
            <span className="text-right font-bold leading-tight" style={{ color }}>
              <span className="block text-[9px] tracking-[0.14em] opacity-75">TOTAL TOKENS</span>
              <span className="block text-[15px] tabular-nums" aria-label={`${t("総トークン数")} ${tokens}`}>{fmtTokens(tokens)}</span>
              <span className="mt-1 block text-[11px] tracking-[0.12em]">SO<br />ELECTRIC</span>
            </span>
          </span>
        </div>
      </div>
      {menu && (
        <Sheet label={t("プロフィール")} onClose={() => setMenu(false)}>
          <SheetCard>
            <Tiles>
              <TileButton icon="download" label={busy ? t("保存しています…") : t("画像で保存")} disabled={busy} onClick={() => void download()} />
              <label className="flex min-h-[68px] min-w-0 flex-1 cursor-pointer flex-col items-center justify-center gap-1 rounded-2xl bg-chip/70 px-1 py-2 text-[11.5px] font-medium text-ink">
                <Glyph name="image" />
                <span className="truncate">{t("顔を変える")}</span>
                <input type="file" accept="image/png,image/jpeg,image/webp" aria-label={t("顔を変える")} className="sr-only" onChange={(e) => void upload(e.target.files?.[0])} />
              </label>
              <label className="flex min-h-[68px] min-w-0 flex-1 cursor-pointer flex-col items-center justify-center gap-1 rounded-2xl bg-chip/70 px-1 py-2 text-[11.5px] font-medium text-ink">
                <span className="size-5 rounded-full border border-line-2" style={{ background: color }} aria-hidden="true" />
                <span className="truncate">{t("色を変える")}</span>
                <input type="color" defaultValue={color} onChange={(e) => void patch({ color: e.target.value })} aria-label={t("色を変える")} className="sr-only" />
              </label>
            </Tiles>
            <div className="flex flex-col gap-2 px-3.5 pb-3.5">
              <label className="flex items-center gap-3 text-[12.5px] text-mute">
                <span className="w-14 flex-none">{t("呼び名")}</span>
                <input key={`o:${about.owner}`} defaultValue={hasName ? about.owner : ""} maxLength={40} onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== about.owner && void saveOwner(e.target.value.trim()).catch((x) => setError(String(x.message ?? x)))} className={`${field} text-ink`} />
              </label>
              <label className="flex items-center gap-3 text-[12.5px] text-mute">
                <span className="w-14 flex-none">{t("肩書き")}</span>
                <input key={`t:${title}`} defaultValue={title} maxLength={40} placeholder="Breezy Operator" onBlur={(e) => e.target.value.trim() !== title && void patch({ title: e.target.value })} className={`${field} text-ink`} />
              </label>
            </div>
            {error && <div className="mx-3.5 mb-3 rounded-xl bg-orange-soft px-3 py-2 text-xs text-orange-ink" role="alert">{error}</div>}
          </SheetCard>
          {about.ownerAvatar && <DangerButton label={t("顔を外す")} onClick={() => void patch({ avatar: null })} />}
        </Sheet>
      )}
    </section>
  );
}
