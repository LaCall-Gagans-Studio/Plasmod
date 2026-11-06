// 左のメニューの左下の角から、アイコンと同じアメーバが偽足を伸ばす。開いた瞬間にバーンと広がり、
// そのあとは偽足が波打ちながら曲がり・伸び縮みする。偽足は節の連なりで、途中から枝分かれする。
// 先端をつまむと引っ張って伸ばせる（伸びた分だけ細くなる）。離すとびよんと戻る。目はきょろきょろ・まばたき、引っ張っている間はそっちを見る。
// 偽足は1本ずつ管の形の path にして、ぼかし＋しきい値のフィルター（goo）で本体・枝とつなぐ。
// 形は閉じた Catmull-Rom 曲線でなめらかにつないだもの（アイコンも同じ作り方）。毎フレームは React を通さず path を直接書き換える。active のときだけ動く。
import { type PointerEvent, useEffect, useRef } from "react";

type Pt = [number, number];

function loopPath(pts: readonly Pt[]): string {
  const n = pts.length;
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const p3 = pts[(i + 2) % n];
    d += ` C${(p1[0] + (p2[0] - p0[0]) / 6).toFixed(1)},${(p1[1] + (p2[1] - p0[1]) / 6).toFixed(1)} ${(p2[0] - (p3[0] - p1[0]) / 6).toFixed(1)},${(p2[1] - (p3[1] - p1[1]) / 6).toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return `${d}Z`;
}

function blobPath(cx: number, cy: number, radii: number[], rot = 0): string {
  const n = radii.length;
  return loopPath(radii.map((r, i) => {
    const a = rot + (2 * Math.PI * i) / n;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  }));
}

// 画面は 400×400、中心は左下の角（0,400）。見えるのは右上の 1/4（角度 -90°〜0°）
const CX = 0;
const CY = 400;
/** 本体から偽足が出るところの半径 */
const ROOT_R = 105;

/**
 * 偽足: parent は親の偽足（-1 は本体）、at は親の何番目の節から出るか、deg は向き（本体からは絶対、枝は親の向きからの差）、
 * n・seg は節の数と長さ、w0・w1 は根元と先の太さ（半分）、bend は節ごとの曲がり（ラジアン）、curl は根元から先へ流れるうねりの大きさ、sp・ph は速さと位相。
 * 親は子より前に置く。枝はとなりの偽足とくっつくと輪になって穴が開くので、外側か先のほうから出す。
 */
interface Limb { parent: number; at: number; deg: number; n: number; seg: number; w0: number; w1: number; bend: number; curl: number; sp: number; ph: number }
const LIMBS: Limb[] = [
  { parent: -1, at: 0, deg: -86, n: 6, seg: 30, w0: 26, w1: 10, bend: 0.06, curl: 0.13, sp: 0.5, ph: 0 },
  { parent: -1, at: 0, deg: -63, n: 4, seg: 28, w0: 22, w1: 10, bend: -0.12, curl: 0.16, sp: 0.8, ph: 1.3 },
  { parent: -1, at: 0, deg: -45, n: 8, seg: 29, w0: 28, w1: 11, bend: 0.05, curl: 0.11, sp: 0.45, ph: 2.1 },
  { parent: -1, at: 0, deg: -30, n: 5, seg: 28, w0: 22, w1: 10, bend: -0.09, curl: 0.15, sp: 0.7, ph: 0.6 },
  { parent: -1, at: 0, deg: -9, n: 7, seg: 29, w0: 25, w1: 10, bend: -0.015, curl: 0.12, sp: 0.55, ph: 2.8 },
  { parent: 2, at: 5, deg: 40, n: 3, seg: 23, w0: 14, w1: 8, bend: 0.12, curl: 0.2, sp: 0.9, ph: 0.4 },
  { parent: 0, at: 5, deg: 50, n: 2, seg: 22, w0: 12, w1: 7, bend: 0.1, curl: 0.2, sp: 1.0, ph: 2.4 },
  { parent: 4, at: 3, deg: 38, n: 2, seg: 22, w0: 13, w1: 8, bend: 0.1, curl: 0.18, sp: 0.85, ph: 1.7 },
  { parent: 2, at: 6, deg: -36, n: 3, seg: 20, w0: 11, w1: 7, bend: -0.14, curl: 0.22, sp: 1.1, ph: 3.3 },
  { parent: 5, at: 2, deg: -42, n: 2, seg: 18, w0: 9, w1: 6, bend: 0.1, curl: 0.25, sp: 1.2, ph: 0.9 },
  { parent: 3, at: 4, deg: -40, n: 2, seg: 20, w0: 11, w1: 7, bend: -0.12, curl: 0.2, sp: 0.95, ph: 4.1 },
];

/** つまんでいる・戻っている偽足。amt は 1 で指の位置まで、0 でいつもの形（離すとばねで 0 へ。少し行き過ぎる） */
interface Pull { held: boolean; tx: number; ty: number; amt: number; vel: number }
/** どこまで伸ばせるか（いつもの長さの倍） */
const MAX_STRETCH = 2.8;

const easeOutBack = (x: number) => 1 + 2.4 * (x - 1) ** 3 + 1.4 * (x - 1) ** 2;
const dist = (a: Pt, b: Pt) => Math.hypot(b[0] - a[0], b[1] - a[1]);

/** 根元を止めたまま、先を target に向けて節をたどり直す（FABRIK）。届かないぶんは節を伸ばす */
function reach(rest: Pt[], target: Pt): { pts: Pt[]; s: number } {
  const lens = rest.slice(1).map((p, k) => dist(rest[k], p));
  const total = lens.reduce((a, b) => a + b, 0) || 1;
  const s = Math.min(MAX_STRETCH, Math.max(1, dist(rest[0], target) / total));
  const L = lens.map((l) => l * s);
  const p = rest.map((q) => [q[0], q[1]] as Pt);
  const toward = (from: Pt, to: Pt, len: number): Pt => {
    const d = dist(from, to) || 1;
    return [from[0] + ((to[0] - from[0]) * len) / d, from[1] + ((to[1] - from[1]) * len) / d];
  };
  for (let it = 0; it < 5; it++) {
    p[p.length - 1] = [target[0], target[1]];
    for (let k = p.length - 2; k >= 0; k--) p[k] = toward(p[k + 1], p[k], L[k]);
    p[0] = [rest[0][0], rest[0][1]];
    for (let k = 1; k < p.length; k++) p[k] = toward(p[k - 1], p[k], L[k - 1]);
  }
  return { pts: p, s };
}

/** 節の並びを、太さが根元から先へ細くなる管にする（先は少しふくらんで丸い） */
function tube(pts: Pt[], l: Limb, thin: number, grow: number): string {
  const n = pts.length - 1;
  const w = pts.map((_, k) => (l.w1 + (l.w0 - l.w1) * (1 - k / n) ** 1.2) * (k === n ? 1.25 : 1) * thin * Math.min(1, grow));
  const tan = pts.map((_, k) => {
    const a = pts[Math.max(0, k - 1)];
    const b = pts[Math.min(n, k + 1)];
    const d = dist(a, b) || 1;
    return [(b[0] - a[0]) / d, (b[1] - a[1]) / d] as Pt;
  });
  const side = (k: number, sign: number): Pt => [pts[k][0] - tan[k][1] * w[k] * sign, pts[k][1] + tan[k][0] * w[k] * sign];
  const cap = (k: number, from: number, sign: number): Pt[] =>
    [1, 2, 3, 4].map((j) => {
      const th = from + (j * Math.PI) / 5;
      const nx = -tan[k][1];
      const ny = tan[k][0];
      return [pts[k][0] + w[k] * (nx * Math.cos(th) + tan[k][0] * sign * Math.sin(th)), pts[k][1] + w[k] * (ny * Math.cos(th) + tan[k][1] * sign * Math.sin(th))];
    });
  const out: Pt[] = [];
  for (let k = 0; k <= n; k++) out.push(side(k, 1));
  out.push(...cap(n, 0, 1));
  for (let k = n; k >= 0; k--) out.push(side(k, -1));
  out.push(...cap(0, Math.PI, 1));
  return loopPath(out);
}

function shape(t: number, grow: number, pulls: Map<number, Pull>): { core: string; limbs: string[]; tips: Pt[] } {
  const core = blobPath(CX, CY, Array.from({ length: 48 }, (_, i) => {
    const a = (2 * Math.PI * i) / 48;
    return Math.max(0, (138 + 8 * Math.sin(a * 5 + t * 0.6) + 5 * Math.sin(a * 9 - t * 0.9)) * grow);
  }));
  const spines: Pt[][] = [];
  const limbs = LIMBS.map((l, i) => {
    let root: Pt;
    let dir: number;
    if (l.parent < 0) {
      dir = (l.deg * Math.PI) / 180 + 0.08 * Math.sin(t * l.sp * 0.6 + l.ph);
      root = [CX + ROOT_R * grow * Math.cos(dir), CY + ROOT_R * grow * Math.sin(dir)];
    } else {
      const ps = spines[l.parent];
      const a = ps[l.at];
      const b = ps[Math.min(ps.length - 1, l.at + 1)];
      root = a;
      dir = Math.atan2(b[1] - a[1], b[0] - a[0]) + (l.deg * Math.PI) / 180 + 0.1 * Math.sin(t * l.sp * 0.5 + l.ph);
    }
    // 根元から先へ流れるうねり（節ごとに位相をずらす）と、ゆっくりした伸び縮み
    const rest: Pt[] = [root];
    for (let k = 1; k <= l.n; k++) {
      dir += l.bend + l.curl * Math.sin(t * l.sp + l.ph - k * 0.9);
      const len = l.seg * grow * (0.88 + 0.14 * Math.sin(t * l.sp * 0.7 + l.ph + k * 0.4));
      const p = rest[k - 1];
      rest.push([p[0] + len * Math.cos(dir), p[1] + len * Math.sin(dir)]);
    }
    const pull = pulls.get(i);
    let pts = rest;
    let thin = 1;
    if (pull) {
      const { pts: ik, s } = reach(rest, [pull.tx, pull.ty]);
      pts = rest.map((p, k) => [p[0] + (ik[k][0] - p[0]) * pull.amt, p[1] + (ik[k][1] - p[1]) * pull.amt]);
      // 伸びたぶんだけ細くなる（体積はだいたい同じ）
      thin = 1 / Math.sqrt(Math.max(0.6, 1 + (s - 1) * pull.amt));
    }
    spines.push(pts);
    return tube(pts, l, thin, grow);
  });
  // 本体から出る偽足どうしのあいだに水かきを張る（付け根の近くに背景の穴が残らないように）。あいだは角のほうへ少しへこませる
  const bases = LIMBS.flatMap((l, i) => (l.parent < 0 ? [spines[i][Math.min(2, l.n)]] : []));
  const web: Pt[] = [[CX, CY]];
  bases.forEach((p, j) => {
    if (j > 0) {
      const q = bases[j - 1];
      web.push([CX + ((p[0] + q[0]) / 2 - CX) * 0.8, CY + ((p[1] + q[1]) / 2 - CY) * 0.8]);
    }
    web.push(p);
  });
  return { core: `${core} ${loopPath(web)}`, limbs, tips: spines.map((s) => s[s.length - 1]) };
}

// 目は本体の上（角から右上へ）
const EX = 92;
const EY = 304;
const SCLERA = [36, 39, 35, 38, 40, 34, 37, 39];
const sclera = (t: number) => blobPath(EX, EY, SCLERA.map((r, i) => r + 1.6 * Math.sin(t * 0.7 + i)), 0.4);

/** つまめる範囲: 先端からこれ以内（画面の単位） */
const GRAB_R = 90;

export function AmoebaBurst({ active }: { active: boolean }) {
  const svgEl = useRef<SVGSVGElement>(null);
  const coreEl = useRef<SVGPathElement>(null);
  const limbEls = useRef<(SVGPathElement | null)[]>([]);
  const eyeEl = useRef<SVGPathElement>(null);
  const eyeG = useRef<SVGGElement>(null);
  const lidEl = useRef<SVGGElement>(null);
  const pupilEl = useRef<SVGGElement>(null);
  const pulls = useRef(new Map<number, Pull>());
  const tips = useRef<Pt[]>([]);
  const grabbed = useRef<{ limb: number; pointer: number } | null>(null);

  useEffect(() => {
    if (!active) {
      pulls.current.clear();
      grabbed.current = null;
      return;
    }
    // 動きを減らす設定では、ひとりでには動かない（引っ張るのはできる）
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    const t0 = performance.now();
    let look = { x: 0, y: 0 };
    let lookAt = 0;
    let target = { x: 0, y: 0 };
    let blinkAt = t0 + 2200;
    const frame = (now: number) => {
      const t = still ? 0 : (now - t0) / 1000;
      // 開いた瞬間に角からバーンと広がる（少し行き過ぎて戻る）
      const grow = still ? 1 : easeOutBack(Math.min(1, t / 0.75));
      for (const [i, p] of pulls.current) {
        if (p.held) {
          p.amt += (1 - p.amt) * 0.35;
          p.vel = 0;
        } else {
          // 離したらばねで戻る（少し行き過ぎてびよん）
          p.vel = p.vel * 0.8 - p.amt * 0.16;
          p.amt += p.vel;
          if (Math.abs(p.amt) < 0.003 && Math.abs(p.vel) < 0.003) pulls.current.delete(i);
        }
      }
      const s = shape(t, grow, pulls.current);
      tips.current = s.tips;
      coreEl.current?.setAttribute("d", s.core);
      s.limbs.forEach((d, i) => limbEls.current[i]?.setAttribute("d", d));
      const g = grabbed.current && pulls.current.get(grabbed.current.limb);
      if (g) {
        // 引っ張っている間は指のほうを見る
        const dx = g.tx - EX;
        const dy = g.ty - EY;
        const d = Math.hypot(dx, dy) || 1;
        target = { x: (dx / d) * 14, y: (dy / d) * 11 };
        lookAt = now + 900;
      } else if (now > lookAt && !still) {
        const a = Math.random() * Math.PI * 2;
        const r = Math.random() < 0.25 ? 0 : 7 + Math.random() * 8;
        target = { x: Math.cos(a) * r, y: Math.sin(a) * r * 0.8 };
        lookAt = now + 1200 + Math.random() * 1800;
      }
      look = { x: look.x + (target.x - look.x) * 0.18, y: look.y + (target.y - look.y) * 0.18 };
      if (now > blinkAt + 160) blinkAt = now + 2500 + Math.random() * 3500;
      const blink = now > blinkAt && !still ? Math.sin(((now - blinkAt) / 160) * Math.PI) : 0;
      eyeEl.current?.setAttribute("d", sclera(t));
      // 目も角から一緒に広がる
      eyeG.current?.setAttribute("transform", `translate(${CX} ${CY}) scale(${grow.toFixed(3)}) translate(${-CX} ${-CY}) translate(${(Math.sin(t * 0.5) * 4).toFixed(1)} ${(Math.cos(t * 0.4) * 3).toFixed(1)})`);
      pupilEl.current?.setAttribute("transform", `translate(${look.x.toFixed(2)} ${look.y.toFixed(2)})`);
      lidEl.current?.setAttribute("transform", `translate(0 ${EY}) scale(1 ${(1 - 0.95 * blink).toFixed(3)}) translate(0 ${-EY})`);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [active]);

  /** 指の位置を画面の単位に（引っ張れるのはメニューの中くらいまで） */
  const toSvg = (e: PointerEvent): Pt | null => {
    const m = svgEl.current?.getScreenCTM();
    if (!m) return null;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return [Math.min(420, Math.max(-10, p.x)), Math.min(410, Math.max(-240, p.y))];
  };

  const initial = shape(0, active ? 0 : 1, new Map());
  return (
    <svg ref={svgEl} viewBox="0 0 400 400" preserveAspectRatio="xMinYMax meet" overflow="visible" className="gh-amoeba absolute inset-0 size-full overflow-visible" role="img" aria-label="アメーバ">
      <style>{".gh-amoeba{--am-body:#0D0D0F}:root[data-theme=dark] .gh-amoeba{--am-body:#C8F25A}"}</style>
      <defs>
        {/* ぼかしてから濃いところだけ残す: 重なったところが水滴のようにくっつく */}
        <filter id="gh-am-goo" x="-60" y="-280" width="540" height="720" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
          <feGaussianBlur in="SourceGraphic" stdDeviation="7" result="b" />
          <feColorMatrix in="b" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 24 -10" />
        </filter>
      </defs>
      <g
        filter="url(#gh-am-goo)"
        fill="var(--am-body)"
        className="pointer-events-auto cursor-grab touch-none active:cursor-grabbing"
        // メニューを閉じる左スワイプに取られないように
        onTouchStart={(e) => e.stopPropagation()}
        onTouchMove={(e) => e.stopPropagation()}
        onPointerDown={(e) => {
          const p = toSvg(e);
          if (!p || !active) return;
          // いちばん近い先端をつまむ
          let best = -1;
          let bd = GRAB_R;
          tips.current.forEach((tip, i) => {
            const d = dist(tip, p);
            if (d < bd) [best, bd] = [i, d];
          });
          if (best < 0) return;
          e.stopPropagation();
          (e.target as Element).setPointerCapture(e.pointerId);
          grabbed.current = { limb: best, pointer: e.pointerId };
          const prev = pulls.current.get(best);
          pulls.current.set(best, { held: true, tx: p[0], ty: p[1], amt: prev?.amt ?? 0, vel: 0 });
        }}
        onPointerMove={(e) => {
          const g = grabbed.current;
          const p = g?.pointer === e.pointerId ? toSvg(e) : null;
          const pull = g && pulls.current.get(g.limb);
          if (!p || !pull) return;
          pull.tx = p[0];
          pull.ty = p[1];
        }}
        onPointerUp={(e) => release(e.pointerId)}
        onPointerCancel={(e) => release(e.pointerId)}
      >
        <path ref={coreEl} d={initial.core} />
        {initial.limbs.map((d, i) => (
          <path key={i} ref={(el) => void (limbEls.current[i] = el)} d={d} />
        ))}
      </g>
      <g ref={eyeG} className="pointer-events-none">
        <g ref={lidEl}>
          <path ref={eyeEl} id="gh-am-sclera" d={sclera(0)} fill="#F3F1EC" />
          {/* 黒目は白目の中だけに出す */}
          <clipPath id="gh-am-eye">
            <use href="#gh-am-sclera" />
          </clipPath>
          <g clipPath="url(#gh-am-eye)">
            <g ref={pupilEl}>
              <circle cx={EX + 4} cy={EY + 2} r="22" fill="#0D0D0F" />
              <circle cx={EX - 4} cy={EY - 6} r="6" fill="#FFFFFF" />
              <circle cx={EX + 11} cy={EY + 10} r="2.6" fill="#FFFFFF" opacity=".7" />
            </g>
          </g>
        </g>
        <circle cx="122" cy="368" r="8" fill="#F3F1EC" opacity=".3" />
        <circle cx="34" cy="292" r="6" fill="#F3F1EC" opacity=".3" />
      </g>
    </svg>
  );

  function release(pointer: number) {
    const g = grabbed.current;
    if (g?.pointer !== pointer) return;
    const pull = pulls.current.get(g.limb);
    if (pull) pull.held = false;
    grabbed.current = null;
  }
}

