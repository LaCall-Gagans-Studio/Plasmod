// プロフィールカードの生き物。名前から形が決まり、枠の中をゆっくり這い回る。
// 頭（目玉のある体）が向きを変えながら進み、節がその跡を追い、節から伸びる細い触手が揺れる。
// 毎フレームは React を通さず、SVG の属性を直接書き換える。

export const W = 300;
export const H = 290;
const SEGS = 11;
const GAP = 18;

type Pt = [number, number];

/** 名前から決まる乱数（同じ名前なら毎回同じ形） */
export function seeded(text: string) {
  let h = 2166136261;
  for (const c of text) h = Math.imul(h ^ c.codePointAt(0)!, 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507) ^ Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

interface Wire {
  seg: number;
  side: number;
  /** 節の向きからの角度と、節ごとの長さ・曲がり */
  a0: number;
  lens: number[];
  bends: number[];
  ph: number;
}

export interface Creature {
  x: number;
  y: number;
  dir: number;
  /** 向きのうねり */
  ph: number;
  segs: Pt[];
  wires: Wire[];
  radii: number[];
  shards: { x: number; y: number; w: number; h: number; o: number }[];
}

export function makeCreature(seed: string): Creature {
  const r = seeded(seed || "plasmod");
  const x = W * 0.62;
  const y = H * 0.68;
  const dir = -0.5 + r();
  const segs: Pt[] = [];
  // 最初は弧を描いて巻いた形
  let px = x;
  let py = y;
  let a = dir + Math.PI;
  for (let i = 0; i < SEGS; i++) {
    px += (i === 0 ? 32 : GAP) * Math.cos(a);
    py += (i === 0 ? 32 : GAP) * Math.sin(a);
    segs.push([px, py]);
    a += 0.2;
  }
  const wires: Wire[] = [];
  for (let i = 0; i < SEGS; i++) {
    for (const side of [-1, 1]) {
      const n = 2 + Math.floor(r() * 2);
      wires.push({
        seg: i,
        side,
        a0: side * (1.2 + r() * 0.5),
        lens: Array.from({ length: n }, () => 16 + r() * 24),
        bends: Array.from({ length: n }, () => (r() - 0.5) * 1.1),
        ph: r() * 6.28,
      });
    }
  }
  return {
    x,
    y,
    dir,
    ph: r() * 6.28,
    segs,
    wires,
    radii: Array.from({ length: 14 }, () => 27 + r() * 9),
    shards: Array.from({ length: 7 }, () => ({ x: r() * W, y: r() * H, w: 6 + r() * 26, h: 1.5 + r() * 3, o: 0.12 + r() * 0.25 })),
  };
}

const SPEED = 15; // 1秒に進む量
const MARGIN = 46;

/** dt 秒ぶん進める。枠に近づくと内側へ向きを変える */
export function step(c: Creature, dt: number, t: number) {
  // 窓はアーチ形なので、上のほうは左右が狭い
  const top = MARGIN + 6;
  const half = c.y < H * 0.5 ? (W / 2) * Math.sqrt(Math.max(0.15, 1 - ((H * 0.5 - c.y) / (H * 0.5)) ** 2)) - MARGIN : W / 2 - MARGIN;
  const out = c.x < W / 2 - half || c.x > W / 2 + half || c.y < top || c.y > H - MARGIN;
  if (out) {
    const toCenter = Math.atan2(H * 0.55 - c.y, W / 2 - c.x);
    const diff = Math.atan2(Math.sin(toCenter - c.dir), Math.cos(toCenter - c.dir));
    c.dir += Math.sign(diff) * Math.min(Math.abs(diff), 2.2 * dt);
  } else {
    c.dir += (0.55 * Math.sin(t * 0.7 + c.ph) + 0.3 * Math.sin(t * 1.9 + c.ph * 2)) * dt;
  }
  // 脈を打つように、速くなったり遅くなったりする
  const v = SPEED * (0.6 + 0.4 * Math.sin(t * 1.3 + c.ph) ** 2);
  c.x += Math.cos(c.dir) * v * dt;
  c.y += Math.sin(c.dir) * v * dt;
  // 節は前の節を追う
  let prev: Pt = [c.x, c.y];
  c.segs.forEach((s, i) => {
    const gap = i === 0 ? 32 : GAP;
    const dx = s[0] - prev[0];
    const dy = s[1] - prev[1];
    const d = Math.hypot(dx, dy) || 1;
    s[0] = prev[0] + (dx / d) * gap;
    s[1] = prev[1] + (dy / d) * gap;
    prev = s;
  });
}

export const segAngle = (c: Creature, i: number) => {
  const a = c.segs[i];
  const b: Pt = i === 0 ? [c.x, c.y] : c.segs[i - 1];
  return Math.atan2(b[1] - a[1], b[0] - a[0]);
};

export function wirePoints(c: Creature, w: Wire, t: number): Pt[] {
  const [sx, sy] = c.segs[w.seg];
  const pts: Pt[] = [[sx, sy]];
  let a = segAngle(c, w.seg) + w.a0 + 0.14 * Math.sin(t * 1.4 + w.ph);
  let x = sx;
  let y = sy;
  w.lens.forEach((len, k) => {
    x += len * Math.cos(a);
    y += len * Math.sin(a);
    pts.push([x, y]);
    a += w.bends[k] + 0.1 * Math.sin(t * 1.1 + w.ph + k);
  });
  return pts;
}

export const wirePath = (pts: Pt[]) => pts.map((p, k) => `${k ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("");

/** XML の文字を逃がす */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** カードの絵（1枚の SVG）。画面の生き物の今の姿をそのまま入れる。foreignObject を使わないので画像にできる */
export function cardSvg(o: { specimen: string; name: string; title: string; color: string; days: number; joined: string }): string {
  const c = esc(o.color);
  const bars = Array.from({ length: 22 }, (_, i) => `<rect x="${40 + i * 14}" y="718" width="12" height="7" fill="${c}" opacity="${(((i * 7) % 11) / 11 + 0.12).toFixed(2)}"/>`).join("");
  const sans = `font-family="'IBM Plex Sans JP','Noto Sans JP',system-ui,sans-serif"`;
  const mono = `font-family="'JetBrains Mono',ui-monospace,monospace"`;
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1240" height="1800" viewBox="0 0 620 900">
<defs>
<radialGradient id="g" cx="50%" cy="38%" r="72%"><stop offset="0" stop-color="${c}" stop-opacity=".26"/><stop offset="1" stop-color="#07080A"/></radialGradient>
<clipPath id="arch"><path d="M40 344a270 270 0 0 1 540 0V596H40z"/></clipPath>
<path id="ring" d="M95 790 m-38 0 a38 38 0 1 1 76 0 a38 38 0 1 1 -76 0"/>
</defs>
<rect width="620" height="900" fill="#07080A"/><rect width="620" height="900" fill="url(#g)"/>
<rect x="18" y="18" width="584" height="864" fill="#07080A" stroke="${c}" stroke-opacity=".6"/>
<text x="40" y="58" ${mono} font-size="14" letter-spacing="2.2" fill="#E8E8E2" opacity=".7">PLASMODIUM SP.</text>
<text x="580" y="58" ${mono} font-size="14" letter-spacing="2.2" fill="#E8E8E2" opacity=".7" text-anchor="end">PLATE ${String(o.days).padStart(4, "0")}</text>
<g clip-path="url(#arch)"><svg x="40" y="74" width="540" height="522" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice">${o.specimen}</svg></g>
<path d="M40 344a270 270 0 0 1 540 0V596H40z" fill="none" stroke="${c}" stroke-width="1.5"/>
<text x="40" y="664" ${sans} font-size="56" font-weight="900" fill="#fff">${esc(o.name)}</text>
<text x="40" y="702" ${mono} font-size="22" letter-spacing="1" fill="${c}">${esc(o.title)}</text>
${bars}
<g transform="rotate(-12 95 790)" fill="none" stroke="${c}">
<circle cx="95" cy="790" r="47" stroke-width="2.5"/><circle cx="95" cy="790" r="30" stroke-width="1.5"/>
<text ${mono} font-size="11.5" font-weight="700" letter-spacing="2.6" fill="${c}" stroke="none"><textPath href="#ring" xlink:href="#ring">PLASMOD · ACTIVE DAYS · </textPath></text>
<text x="95" y="799" text-anchor="middle" ${mono} font-size="${o.days > 999 ? 18 : 26}" font-weight="800" fill="${c}" stroke="none">${o.days}</text>
</g>
<g ${mono} font-size="15" font-weight="700" fill="${c}">
<rect x="40" y="842" width="262" height="30" fill="none" stroke="${c}"/>
<text x="50" y="862">PLASMOD</text>
<rect x="128" y="842" width="20" height="30" fill="${c}" opacity=".35"/>
<text x="158" y="862">${esc(o.joined)}</text>
</g>
<text x="580" y="848" text-anchor="end" ${mono} font-size="16" font-weight="700" letter-spacing="2" fill="${c}">SO</text>
<text x="580" y="868" text-anchor="end" ${mono} font-size="16" font-weight="700" letter-spacing="2" fill="${c}">ELECTRIC</text>
</svg>`;
}
