// プロフィールカードの生き物。名前から形が決まり、枠の中をゆっくり這い回る。
// 頭（目玉のある体）が向きを変えながら進み、節がその跡を追い、節から伸びる細い触手が揺れる。
// 毎フレームは React を通さず、SVG の属性を直接書き換える。

export const W = 300;
export const H = 290;
const GAP = 18;
const MAX_SEGS = 26;
const MAX_JOINTS = 7;

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

/** 使ったトークンの総数から、育ち具合（0〜）を決める。対数なので、序盤はぐんぐん、後半はゆっくり育つ */
export const growth = (tokens: number) => Math.log2(1 + Math.max(0, tokens || 0) / 2e5);

/** トークン数を短く（1.23B など） */
export function fmtTokens(n: number): string {
  n = Math.max(0, Math.floor(n || 0));
  if (n < 1000) return String(n);
  const units = ["K", "M", "B", "T", "Q"];
  let v = n;
  let u = -1;
  while (v >= 1000 && u < units.length - 1) {
    v /= 1000;
    u++;
  }
  return `${v >= 100 ? Math.round(v) : v >= 10 ? v.toFixed(1) : v.toFixed(2)}${units[u]}`;
}

/** 節についた飾り。生えてくる時期は節ごとにばらばら */
export interface Organ {
  kind: "fin" | "spike" | "bud";
  side: number;
  /** 伸びきったときの長さ */
  max: number;
  /** 今の長さ（育ち具合から） */
  len: number;
  tilt: number;
}

export interface SegInfo {
  /** 生えたての節は小さい */
  scale: number;
  sx: number;
  sy: number;
  organs: Organ[];
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
  /** 育ち具合 */
  g: number;
  info: SegInfo[];
  /** 頭にある、よぶんな目 */
  eyes: { x: number; y: number; r: number }[];
  shards: { x: number; y: number; w: number; h: number; o: number }[];
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/**
 * 名前から決まる姿を、トークンの総数に応じて育てる。
 * 決め打ちの段階は無く、法則だけがある:
 *  - 節は増え続ける（上限あり）。生えたての節は小さい
 *  - 肢は節ごと・左右ごとに、別々の時期に生える。生えてからの年数で、関節が増え、長くなる
 *  - 肢は一本ごとに決まった向きへ巻く癖がある
 *  - ひれ・とげ・こぶは、節ごとにばらばらの時期に現れる
 *  - 目は育つと増える
 * 乱数は部位ごとに独立しているので、育っても既にある部位の形は変わらない。
 */
export function makeCreature(seed: string, tokens = 0): Creature {
  const base = seed || "plasmod";
  const g = growth(tokens);
  const r = seeded(base);
  const x = W * 0.62;
  const y = H * 0.68;
  const dir = -0.5 + r();
  const ph = r() * 6.28;
  const radii = Array.from({ length: 14 }, () => 27 + r() * 9);
  const headScale = 1 + Math.min(g, 14) * 0.025;
  const count = Math.min(MAX_SEGS, 6 + Math.floor(g * 1.5));

  const segs: Pt[] = [];
  const info: SegInfo[] = [];
  const wires: Wire[] = [];
  // 最初は弧を描いて巻いた形
  let px = x;
  let py = y;
  let a = dir + Math.PI;
  for (let i = 0; i < count; i++) {
    px += (i === 0 ? 32 : GAP) * Math.cos(a);
    py += (i === 0 ? 32 : GAP) * Math.sin(a);
    segs.push([px, py]);
    a += 0.2;

    const sr = seeded(`${base}|seg${i}`);
    const born = Math.max(0, (i - 6) / 1.5); // 節が生えた時期（育ち具合）
    const scale = i < 6 ? 1 : 0.35 + 0.65 * clamp01((g - born) / 0.8);
    const sx = 0.8 + sr() * 0.5;
    const sy = 0.85 + sr() * 0.45;

    const organs: Organ[] = [];
    const nOrgans = sr() < 0.55 ? 1 + Math.floor(sr() * 2) : 0;
    for (let k = 0; k < nOrgans; k++) {
      const kr = sr();
      const kind: Organ["kind"] = kr < 0.4 ? "fin" : kr < 0.75 ? "spike" : "bud";
      const birth = 2 + sr() * 9 + i * 0.1;
      const max = 7 + sr() * 15;
      const side = sr() < 0.5 ? -1 : 1;
      const tilt = (sr() - 0.5) * 0.9;
      if (g > birth) organs.push({ kind, side, max, len: max * clamp01((g - birth) / 3), tilt });
    }
    info.push({ scale, sx, sy, organs });

    for (const side of [-1, 1]) {
      const wr = seeded(`${base}|wire${i}|${side}`);
      // 生える時期はばらばら。全部の節に生えるわけではない
      const has = wr() < 0.85;
      const birth = (i < 6 ? 0 : (i - 6) / 1.5) * 0.5 + wr() * 4 - 2;
      const a0 = side * (1.2 + wr() * 0.5);
      const rate = 0.6 + wr() * 0.9;
      const drift = (wr() - 0.5) * 0.7; // 巻く癖
      const lens = Array.from({ length: MAX_JOINTS }, () => 16 + wr() * 24);
      const bends = Array.from({ length: MAX_JOINTS }, () => drift + (wr() - 0.5) * 0.8);
      const ph2 = wr() * 6.28;
      const age = g - birth;
      if (!has || age < 0) continue;
      const joints = Math.min(MAX_JOINTS, 2 + Math.floor(age * 0.55 * rate));
      const stretch = Math.min(2.4, 0.3 + age * 0.3 * rate);
      wires.push({
        seg: i,
        side,
        a0,
        lens: lens.slice(0, joints).map((l) => l * stretch),
        bends: bends.slice(0, joints),
        ph: ph2,
      });
    }
  }

  const er = seeded(`${base}|eyes`);
  const eyes = Array.from({ length: Math.min(5, Math.floor(g / 3.5)) }, () => {
    const ang = er() * Math.PI * 2;
    const d = 20 + er() * 10;
    return { x: Math.cos(ang) * d * headScale, y: Math.sin(ang) * d * headScale, r: 3.5 + er() * 3.5 };
  });

  return {
    x,
    y,
    dir,
    ph,
    segs,
    wires,
    radii: radii.map((v) => v * headScale),
    g,
    info,
    eyes,
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
export function cardSvg(o: { specimen: string; name: string; title: string; color: string; days: number; joined: string; tokens?: number }): string {
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
<text x="580" y="770" text-anchor="end" ${mono} font-size="12" font-weight="700" letter-spacing="2.4" fill="${c}" opacity=".75">TOKENS</text>
<text x="580" y="800" text-anchor="end" ${mono} font-size="30" font-weight="800" fill="${c}">${esc(fmtTokens(o.tokens ?? 0))}</text>
<text x="580" y="848" text-anchor="end" ${mono} font-size="16" font-weight="700" letter-spacing="2" fill="${c}">SO</text>
<text x="580" y="868" text-anchor="end" ${mono} font-size="16" font-weight="700" letter-spacing="2" fill="${c}">ELECTRIC</text>
</svg>`;
}
