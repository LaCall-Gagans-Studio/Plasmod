// 読み込み中の見せ方。最初は目玉のあるアメーバ、一覧はスケルトン。文字の「読み込み中…」を出さない。
// 読み込みが終わると、アメーバから新しい触手が次々に伸びて枝分かれし、画面を埋めて次の画面へ切り替わる（burst）。
import { type ReactNode, useEffect, useRef, useState } from "react";

/** 体と触手の色（起動画面 index.html と同じ） */
const BODY = "#a3c93a";
const SCLERA = "#F3F1EC";
const PUPIL = "#0D0D0F";
const SIZE = 200;
const C = SIZE / 2;
const CORE = 30;
const EYE = 17;
/** これより短く出ていたら広げない（すぐ読み終わるたびに光らせない） */
const MIN_VISIBLE_MS = 180;
const ARMS = [
  { deg: -90, len: 56, w: 11, sp: 1.1, ph: 0 },
  { deg: -42, len: 44, w: 9, sp: 1.5, ph: 1.4 },
  { deg: 5, len: 60, w: 11, sp: 0.95, ph: 2.6 },
  { deg: 50, len: 42, w: 9, sp: 1.35, ph: 0.8 },
  { deg: 96, len: 58, w: 11, sp: 1.2, ph: 3.5 },
  { deg: 142, len: 46, w: 9, sp: 1.55, ph: 2.1 },
  { deg: 188, len: 60, w: 11, sp: 1.0, ph: 4.4 },
  { deg: 232, len: 44, w: 9, sp: 1.45, ph: 5.2 },
];

type Pt = [number, number];

/** 点の列をなめらかにつなぐ（中点を通る2次曲線） */
function smooth(pts: Pt[]): string {
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2;
    const my = (pts[i][1] + pts[i + 1][1]) / 2;
    d += ` Q${pts[i][0].toFixed(1)},${pts[i][1].toFixed(1)} ${mx.toFixed(1)},${my.toFixed(1)}`;
  }
  const last = pts[pts.length - 1];
  return `${d} L${last[0].toFixed(1)},${last[1].toFixed(1)}`;
}

/** 根元から節をうねらせながら伸ばす */
function spine(x0: number, y0: number, dir0: number, len: number, sp: number, ph: number, t: number, bend = 0.3): Pt[] {
  const seg = len / 5;
  const pts: Pt[] = [[x0, y0]];
  let dir = dir0;
  let x = x0;
  let y = y0;
  for (let k = 1; k <= 5; k++) {
    dir += bend * Math.sin(t * sp * 1.6 + ph - k * 0.9);
    x += seg * Math.cos(dir);
    y += seg * Math.sin(dir);
    pts.push([x, y]);
  }
  return pts;
}

/** ふだんの触手1本 */
function armPts(a: (typeof ARMS)[number], t: number, cx = C, cy = C): Pt[] {
  const dir = (a.deg * Math.PI) / 180;
  const stretch = 0.82 + 0.22 * Math.sin(t * a.sp * 0.8 + a.ph);
  return spine(cx + (CORE - 6) * Math.cos(dir), cy + (CORE - 6) * Math.sin(dir), dir, a.len * stretch, a.sp, a.ph, t);
}

function reduced() {
  return matchMedia("(prefers-reduced-motion: reduce)").matches;
}

const GROW_MS = 760;
const FADE_MS = 200;
/** 増える触手の数（本数が多いほど隙間なく埋まる） */
const SPROUTS = 72;
const GOLDEN = 2.399963;
const easeOut = (k: number) => 1 - (1 - k) ** 3;
const clamp01 = (k: number) => Math.min(1, Math.max(0, k));

interface Sprout {
  /** 親の触手の番号（-1 は体）と、親のどの節から出るか */
  parent: number;
  at: number;
  /** 伸び始める時刻（0〜1） */
  born: number;
  dir: number;
  len: number;
  w: number;
  sp: number;
  ph: number;
}

/**
 * 読み込みが終わった瞬間: 体の触手に、新しい触手が次々に生えて枝分かれしながら画面を埋める。
 * 目玉は真ん中に残り、埋まりきったら全体が消えて次の画面が見える。
 */
export function burst() {
  if (reduced()) return;
  const W = innerWidth;
  const H = innerHeight;
  const cx = W / 2;
  const cy = H / 2;
  const R = Math.hypot(W, H) / 2;
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("style", "position:fixed;inset:0;width:100%;height:100%;z-index:70;pointer-events:none");

  const sprouts: Sprout[] = ARMS.map((a) => ({ parent: -1, at: 0, born: 0, dir: (a.deg * Math.PI) / 180, len: a.len * 1.6, w: a.w, sp: a.sp, ph: a.ph }));
  for (let i = sprouts.length; i < SPROUTS; i++) {
    // 向きは黄金角で全方向へ散らし、一番近い向きの触手から生やす（偏って隙間が残らないように）
    const dir = i * GOLDEN + (Math.random() - 0.5) * 0.3;
    let parent = 0;
    let best = Infinity;
    for (let j = 0; j < i; j++) {
      const diff = Math.abs(Math.atan2(Math.sin(dir - sprouts[j].dir), Math.cos(dir - sprouts[j].dir)));
      // 同じくらい近いなら、早く生えた親に寄せすぎないよう少しばらつかせる
      const score = diff + Math.random() * 0.25;
      if (score < best) [parent, best] = [j, score];
    }
    const p = sprouts[parent];
    sprouts.push({
      parent,
      at: 2 + Math.floor(Math.random() * 4),
      // 親が伸びてから生える。後ろの番号ほど遅い
      born: Math.max(p.born + 0.06, (i / SPROUTS) * 0.62),
      dir,
      len: R * (0.3 + Math.random() * 0.4),
      w: 7 + Math.random() * 7,
      sp: 1 + Math.random(),
      ph: Math.random() * 6.3,
    });
  }

  const limbs = document.createElementNS(NS, "g");
  limbs.setAttribute("fill", "none");
  limbs.setAttribute("stroke", BODY);
  limbs.setAttribute("stroke-linecap", "round");
  limbs.setAttribute("stroke-linejoin", "round");
  const paths = sprouts.map(() => {
    const el = document.createElementNS(NS, "path");
    limbs.appendChild(el);
    return el;
  });
  const core = document.createElementNS(NS, "circle");
  core.setAttribute("cx", String(cx));
  core.setAttribute("cy", String(cy));
  core.setAttribute("fill", BODY);
  const white = document.createElementNS(NS, "circle");
  white.setAttribute("cx", String(cx));
  white.setAttribute("cy", String(cy));
  white.setAttribute("fill", SCLERA);
  const pupil = document.createElementNS(NS, "circle");
  pupil.setAttribute("cx", String(cx));
  pupil.setAttribute("cy", String(cy));
  pupil.setAttribute("fill", PUPIL);
  svg.append(limbs, core, white, pupil);
  document.body.appendChild(svg);

  const t0 = performance.now();
  const spines: Pt[][] = [];
  const frame = (now: number) => {
    const k = clamp01((now - t0) / GROW_MS);
    const t = (now - t0) / 1000;
    sprouts.forEach((s, i) => {
      const g = easeOut(clamp01((k - s.born) / 0.3));
      if (g <= 0) {
        // まだ生えていない: 親の根元に置いておく（これに生える枝も一緒に待つ）
        spines[i] = [[cx, cy], [cx, cy]];
        paths[i].setAttribute("d", "");
        return;
      }
      const ps = s.parent < 0 ? null : spines[s.parent];
      const [x0, y0]: Pt = ps ? ps[Math.min(s.at, ps.length - 1)] : [cx + (CORE - 6) * Math.cos(s.dir), cy + (CORE - 6) * Math.sin(s.dir)];
      const pts = spine(x0, y0, s.dir, Math.max(1, s.len * g), s.sp, s.ph, t, 0.26);
      spines[i] = pts;
      paths[i].setAttribute("d", smooth(pts));
      // 後半は太っていき、触手どうしがつながって隙間を埋める
      paths[i].setAttribute("stroke-width", (s.w * g * (1 + 16 * k ** 3)).toFixed(1));
    });
    // 最後は体も広がって、残りの隅まで確実に埋める
    core.setAttribute("r", (CORE + (R * 1.1 - CORE) * clamp01((k - 0.6) / 0.4) ** 2).toFixed(1));
    const e = EYE * (1 + 1.2 * k);
    white.setAttribute("r", e.toFixed(1));
    pupil.setAttribute("r", (e * 0.56).toFixed(1));
    pupil.setAttribute("cx", (cx + Math.sin(t * 9) * e * 0.3).toFixed(1));
    if (k < 1) requestAnimationFrame(frame);
    else
      void svg
        .animate([{ opacity: 1 }, { opacity: 0 }], { duration: FADE_MS, easing: "ease-out", fill: "forwards" })
        .finished.catch(() => {})
        .finally(() => svg.remove());
  };
  requestAnimationFrame(frame);
}

export function AmoebaLoader() {
  const arms = useRef<(SVGPathElement | null)[]>([]);
  const pupil = useRef<SVGGElement>(null);
  const shown = useRef(0);
  useEffect(() => {
    shown.current = performance.now();
    const still = reduced();
    let raf = 0;
    const t0 = performance.now();
    const frame = (now: number) => {
      const t = (now - t0) / 1000;
      ARMS.forEach((a, i) => arms.current[i]?.setAttribute("d", smooth(armPts(a, t))));
      // 目はゆっくりきょろきょろ
      pupil.current?.setAttribute("transform", `translate(${(Math.sin(t * 1.3) * 6).toFixed(1)} ${(Math.sin(t * 0.8 + 1) * 4).toFixed(1)})`);
      raf = requestAnimationFrame(frame);
    };
    if (!still) raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      if (performance.now() - shown.current >= MIN_VISIBLE_MS) burst();
    };
  }, []);
  return (
    <div className="flex h-full items-center justify-center" role="status" aria-label="読み込み中">
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden="true">
        <defs>
          {/* ぼかしてから濃いところだけ残す: 触手と体が水滴のようにつながる */}
          <filter id="gh-loader-goo" x="0" y="0" width={SIZE} height={SIZE} filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
            <feGaussianBlur in="SourceGraphic" stdDeviation="4" result="b" />
            <feColorMatrix in="b" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 20 -9" />
          </filter>
        </defs>
        <g filter="url(#gh-loader-goo)" fill="none" stroke={BODY} strokeLinecap="round" strokeLinejoin="round">
          {ARMS.map((a, i) => (
            <path key={a.deg} ref={(el) => void (arms.current[i] = el)} d={smooth(armPts(a, 0))} strokeWidth={a.w} />
          ))}
          <circle cx={C} cy={C} r={CORE} fill={BODY} stroke="none" />
        </g>
        <circle cx={C} cy={C} r={EYE} fill={SCLERA} />
        <g ref={pupil}>
          <circle cx={C} cy={C} r={EYE * 0.56} fill={PUPIL} />
          <circle cx={C - 3} cy={C - 4} r={2.6} fill="#fff" />
        </g>
      </svg>
    </div>
  );
}

export function Skeleton({ rows = 3, className = "" }: { rows?: number; className?: string }) {
  return (
    <div className={`flex flex-col gap-2.5 px-4 py-3 ${className}`} role="status" aria-label="読み込み中">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="gh-skel h-4 rounded-md" style={{ width: `${92 - i * 14}%` }} />
      ))}
    </div>
  );
}

/**
 * 「つながるのを待っている」小さな生き物。体から触手を窓口（右の点）へ伸ばし、届かなければ縮めてまた伸ばす。
 * 待つほど言葉を変える。届いたら（つながったら）この部品ごと消える
 */
export function Seeking({ since, label = "窓口を探しています" }: { since: number; label?: string }) {
  const W = 132;
  const H = 64;
  const cy = H / 2;
  const bx = 30;
  const arm = useRef<SVGPathElement>(null);
  const tip = useRef<SVGCircleElement>(null);
  const pupil = useRef<SVGCircleElement>(null);
  const port = useRef<SVGCircleElement>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (reduced()) return;
    let raf = 0;
    const t0 = performance.now();
    const frame = (ms: number) => {
      const t = (ms - t0) / 1000;
      // 2.6 秒で 伸ばす → ためらう → 縮める
      const ph = (t % 2.6) / 2.6;
      const reach = ph < 0.45 ? easeInOut(ph / 0.45) : ph < 0.62 ? 1 : 1 - easeInOut((ph - 0.62) / 0.38);
      const len = 8 + reach * 62;
      const wob = Math.sin(t * 7) * 3 * reach;
      const x1 = bx + 18 + len;
      const y1 = cy + wob;
      arm.current?.setAttribute("d", `M${bx + 12} ${cy} Q${bx + 18 + len * 0.5} ${cy - 7 * Math.sin(t * 3.1)} ${x1.toFixed(1)} ${y1.toFixed(1)}`);
      arm.current?.setAttribute("stroke-width", (9 - reach * 4).toFixed(1));
      tip.current?.setAttribute("cx", x1.toFixed(1));
      tip.current?.setAttribute("cy", y1.toFixed(1));
      tip.current?.setAttribute("r", (4 + reach * 1.5).toFixed(1));
      // 目は触手の先を追う
      pupil.current?.setAttribute("cx", (bx + 1 + reach * 4).toFixed(1));
      // 窓口はゆっくり脈打つ（触手が近いと少し明るく）
      port.current?.setAttribute("opacity", (0.35 + 0.25 * Math.sin(t * 2.4) ** 2 + 0.3 * reach).toFixed(2));
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);
  const waited = Math.max(0, Math.round((now - since) / 1000));
  const text = waited < 6 ? label : waited < 20 ? "サーバーが起きるのを待っています" : "まだ待っています（デプロイや再起動の途中かもしれません）";
  return (
    <div className="flex flex-col items-center justify-center gap-1.5 px-4 py-8" role="status" aria-live="polite">
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
        <defs>
          <filter id="gh-seek-goo" x="0" y="0" width={W} height={H} filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
            <feGaussianBlur in="SourceGraphic" stdDeviation="2.4" result="b" />
            <feColorMatrix in="b" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -8" />
          </filter>
        </defs>
        <circle ref={port} cx={W - 14} cy={cy} r={5} fill="none" stroke="var(--color-mute)" strokeWidth={1.6} opacity={0.5} />
        <circle cx={W - 14} cy={cy} r={1.8} fill="var(--color-mute)" />
        <g filter="url(#gh-seek-goo)">
          <path ref={arm} d={`M${bx + 12} ${cy} L${bx + 26} ${cy}`} fill="none" stroke={BODY} strokeWidth={9} strokeLinecap="round" />
          <circle ref={tip} cx={bx + 26} cy={cy} r={4} fill={BODY} />
          <circle cx={bx} cy={cy} r={17} fill={BODY} />
        </g>
        <circle cx={bx} cy={cy} r={8.5} fill={SCLERA} />
        <circle ref={pupil} cx={bx + 1} cy={cy} r={4.6} fill={PUPIL} />
      </svg>
      <div className="text-[12.5px] text-mute">
        {text}
        <span className="inline-block w-4 text-left">{".".repeat((waited % 3) + 1)}</span>
      </div>
    </div>
  );
}

const easeInOut = (x: number) => (x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2);

/**
 * 新しいセッションの空の欄。生き物が下の入力欄へ触手を垂らして、ゆらゆら招く。ときどきまばたき。
 * children は下に出す言葉
 */
export function Beckon({ children }: { children: ReactNode }) {
  const W = 120;
  const H = 104;
  const cx = W / 2;
  const cy = 34;
  const arm = useRef<SVGPathElement>(null);
  const tip = useRef<SVGCircleElement>(null);
  const pupil = useRef<SVGCircleElement>(null);
  const lid = useRef<SVGEllipseElement>(null);
  const body = useRef<SVGEllipseElement>(null);
  useEffect(() => {
    if (reduced()) return;
    let raf = 0;
    const t0 = performance.now();
    const frame = (ms: number) => {
      const t = (ms - t0) / 1000;
      // 触手は下へ。先がゆっくり左右にゆれて、ときどき「こっち」と小さく跳ねる
      const sway = Math.sin(t * 1.6) * 9;
      const hop = Math.max(0, Math.sin(t * 1.6 * 0.5 + 0.6)) ** 8 * 6;
      const len = 46 + Math.sin(t * 0.9) * 4 + hop;
      const x1 = cx + sway;
      const y1 = cy + 12 + len;
      arm.current?.setAttribute("d", `M${cx} ${cy + 10} C${cx - sway * 0.6} ${cy + 10 + len * 0.45} ${x1 + sway * 0.4} ${y1 - len * 0.4} ${x1.toFixed(1)} ${y1.toFixed(1)}`);
      tip.current?.setAttribute("cx", x1.toFixed(1));
      tip.current?.setAttribute("cy", y1.toFixed(1));
      // 体はゆっくり息をする
      body.current?.setAttribute("rx", (19 + Math.sin(t * 1.3) * 1.2).toFixed(1));
      body.current?.setAttribute("ry", (17 - Math.sin(t * 1.3) * 1.0).toFixed(1));
      // 目は触手の先を見る
      pupil.current?.setAttribute("cx", (cx + sway * 0.18).toFixed(1));
      // 4 秒に一度まばたき
      const b = (t % 4.2) / 4.2;
      lid.current?.setAttribute("ry", (b > 0.96 ? 9 * Math.sin(((b - 0.96) / 0.04) * Math.PI) : 0).toFixed(1));
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div className="flex flex-1 flex-col items-center justify-end gap-1 px-4 pb-2 pt-6 text-center">
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
        <defs>
          <filter id="gh-beckon-goo" x="0" y="0" width={W} height={H} filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
            <feGaussianBlur in="SourceGraphic" stdDeviation="2.6" result="b" />
            <feColorMatrix in="b" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -8" />
          </filter>
        </defs>
        <g filter="url(#gh-beckon-goo)">
          <path ref={arm} d={`M${cx} ${cy + 10} L${cx} ${cy + 58}`} fill="none" stroke={BODY} strokeWidth={6} strokeLinecap="round" />
          <circle ref={tip} cx={cx} cy={cy + 58} r={4.5} fill={BODY} />
          <ellipse ref={body} cx={cx} cy={cy} rx={19} ry={17} fill={BODY} />
        </g>
        <circle cx={cx} cy={cy - 1} r={9} fill={SCLERA} />
        <circle ref={pupil} cx={cx} cy={cy + 3} r={4.8} fill={PUPIL} />
        <ellipse ref={lid} cx={cx} cy={cy - 1} rx={9.6} ry={0} fill={BODY} />
      </svg>
      <div className="max-w-[18rem] text-[12.5px] leading-relaxed text-mute">{children}</div>
    </div>
  );
}
