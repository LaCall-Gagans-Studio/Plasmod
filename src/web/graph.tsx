// オーケストレーションの図（Obsidian のグラフビュー風）: オーナー・ハブ・エージェント・監察チーム・カンバンのカードを点と線にして、
// 監察チームはハブを通さず、オーナーから直接（点線）。
// ばね（線）と反発（点どうし）でゆらゆら動かす。点はつまんで引っぱれる。押すと、その点とつながる点だけを濃く出す。
// 毎フレームの位置は React を通さず、ref で DOM を直接動かす（点は 30 個くらいまで）。
import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentNode, KanbanTask } from "../shared/types";
import { Avatar } from "./ui";
import { ownerName } from "./identity";

const STATE_RING = { running: "var(--color-ring-lime)", blocked: "var(--color-ring-orange)", idle: "var(--color-ring-idle)" } as const;
const STATE_TEXT = { running: "var(--color-lime-ink)", blocked: "var(--color-orange-ink)", idle: "var(--color-mute)" } as const;
const STATE_LABEL = { running: "実行中", blocked: "停止あり", idle: "待機" } as const;
const TASK_DOT: Partial<Record<KanbanTask["status"], string>> = { running: "#9FD13A", blocked: "#F07A2A", review: "#F2C98A" };
const TASK_LIMIT = 24;

type GNode = { id: string; kind: "me" | "hub" | "agent" | "task"; r: number; charge: number; agent?: AgentNode; task?: KanbanTask };
type GEdge = { a: string; b: string; len: number; live: boolean; watch?: boolean };
type Body = { x: number; y: number; vx: number; vy: number; phase: number; pinned: boolean };

function build(agents: AgentNode[], tasks: KanbanTask[]): { nodes: GNode[]; edges: GEdge[] } {
  const hub = agents.find((a) => a.hub);
  const nodes: GNode[] = [{ id: "me", kind: "me", r: 17, charge: 1 }];
  const edges: GEdge[] = [];
  if (hub) {
    nodes.push({ id: `a:${hub.id}`, kind: "hub", r: 23, charge: 1.4, agent: hub });
    edges.push({ a: "me", b: `a:${hub.id}`, len: 86, live: false });
  }
  for (const a of agents.filter((x) => !x.hub)) {
    const watch = a.team === "watch";
    nodes.push({ id: `a:${a.id}`, kind: "agent", r: watch ? 15 : 17, charge: 1, agent: a });
    edges.push({ a: watch || !hub ? "me" : `a:${hub.id}`, b: `a:${a.id}`, len: watch ? 84 : 92, live: a.state === "running", watch });
  }
  // 開いているカード（止まっている・動いているものを先に）
  const order: KanbanTask["status"][] = ["blocked", "running", "review", "ready", "todo", "triage", "scheduled"];
  const open = tasks.filter((t) => order.includes(t.status)).sort((x, y) => order.indexOf(x.status) - order.indexOf(y.status)).slice(0, TASK_LIMIT);
  const ids = new Set(nodes.map((n) => n.id));
  for (const t of open) {
    const owner = t.assignee && ids.has(`a:${t.assignee}`) ? `a:${t.assignee}` : hub ? `a:${hub.id}` : "me";
    nodes.push({ id: `t:${t.id}`, kind: "task", r: t.status === "running" || t.status === "blocked" ? 5.5 : 4, charge: 0.35, task: t });
    edges.push({ a: owner, b: `t:${t.id}`, len: 40, live: t.status === "running" });
  }
  return { nodes, edges };
}

export function OrchestrationGraph({ agents, tasks }: { agents: AgentNode[]; tasks: KanbanTask[] }) {
  const { nodes, edges } = useMemo(() => build(agents, tasks), [agents, tasks]);
  const box = useRef<HTMLDivElement>(null);
  const bodies = useRef(new Map<string, Body>());
  const nodeEls = useRef(new Map<string, HTMLDivElement>());
  const edgeEls = useRef(new Map<string, SVGLineElement>());
  const size = useRef({ w: 340, h: 300 });
  const drag = useRef<{ id: string; dx: number; dy: number; moved: boolean; sx: number; sy: number } | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const graph = useRef({ nodes, edges });
  graph.current = { nodes, edges };

  // 新しい点は、つながる先の近くから出す（消えた点は捨てる）
  useEffect(() => {
    const m = bodies.current;
    const { w, h } = size.current;
    const live = new Set(nodes.map((n) => n.id));
    for (const id of [...m.keys()]) if (!live.has(id)) m.delete(id);
    nodes.forEach((n, i) => {
      if (m.has(n.id)) return;
      const e = edges.find((x) => x.b === n.id);
      const p = e ? m.get(e.a) : undefined;
      const a = (i * 2.399) % (2 * Math.PI); // 黄金角で散らす（毎回同じ並び）
      const r = p ? 30 : n.kind === "me" ? 0 : 70 + (i % 3) * 20;
      const cx = p ? p.x : n.kind === "me" ? w * 0.22 : w / 2;
      const cy = p ? p.y : h / 2;
      m.set(n.id, { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r, vx: 0, vy: 0, phase: i * 1.7, pinned: false });
    });
  }, [nodes, edges]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => (size.current = { w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    size.current = { w: el.clientWidth, h: el.clientHeight };
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    let t = 0;
    const step = () => {
      t += 1;
      const { nodes, edges } = graph.current;
      const m = bodies.current;
      const { w, h } = size.current;
      const list = nodes.map((n) => [n, m.get(n.id)] as const).filter((x): x is readonly [GNode, Body] => !!x[1]);
      // 反発
      for (let i = 0; i < list.length; i++) {
        const [na, a] = list[i];
        for (let j = i + 1; j < list.length; j++) {
          const [nb, b] = list[j];
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 0.01) {
            dx = Math.random() - 0.5;
            dy = Math.random() - 0.5;
            d2 = 0.5;
          }
          const minD = na.r + nb.r + 6;
          const f = (1400 * na.charge * nb.charge) / Math.max(d2, minD * minD * 0.5);
          const d = Math.sqrt(d2);
          const fx = (dx / d) * f;
          const fy = (dy / d) * f;
          a.vx -= fx / na.charge;
          a.vy -= fy / na.charge;
          b.vx += fx / nb.charge;
          b.vy += fy / nb.charge;
        }
      }
      // ばね
      for (const e of edges) {
        const a = m.get(e.a);
        const b = m.get(e.b);
        if (!a || !b) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.max(Math.hypot(dx, dy), 0.1);
        const f = (d - e.len) * 0.035;
        a.vx += (dx / d) * f;
        a.vy += (dy / d) * f;
        b.vx -= (dx / d) * f;
        b.vy -= (dy / d) * f;
      }
      // 真ん中へ弱く引く・ゆらぎ・減衰・枠の中に
      for (const [n, b] of list) {
        if (b.pinned) {
          b.vx = b.vy = 0;
          continue;
        }
        b.vx += (w / 2 - b.x) * 0.0025;
        b.vy += (h / 2 - b.y) * 0.004;
        if (!still) {
          b.vx += Math.sin(t / 90 + b.phase) * 0.03;
          b.vy += Math.cos(t / 110 + b.phase * 1.3) * 0.03;
        }
        b.vx *= 0.82;
        b.vy *= 0.82;
        // 人の点は下に名前と役割が出るので、その幅だけ左右を空ける
        const mx = n.kind === "task" ? n.r + 4 : 56;
        const my = n.kind === "task" ? n.r + 14 : n.r + 30;
        b.x = Math.min(w - mx, Math.max(mx, b.x + b.vx));
        b.y = Math.min(h - my, Math.max(n.r + 4, b.y + b.vy));
      }
      for (const n of nodes) {
        const b = m.get(n.id);
        const el = nodeEls.current.get(n.id);
        if (b && el) el.style.transform = `translate(${b.x}px, ${b.y}px) translate(-50%, -50%)`;
      }
      for (const e of edges) {
        const a = m.get(e.a);
        const b = m.get(e.b);
        const el = edgeEls.current.get(`${e.a}>${e.b}`);
        if (!a || !b || !el) continue;
        el.setAttribute("x1", String(a.x));
        el.setAttribute("y1", String(a.y));
        el.setAttribute("x2", String(b.x));
        el.setAttribute("y2", String(b.y));
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    const hide = () => {
      cancelAnimationFrame(raf);
      if (document.visibilityState === "visible") raf = requestAnimationFrame(step);
    };
    document.addEventListener("visibilitychange", hide);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      document.removeEventListener("visibilitychange", hide);
    };
  }, []);

  // つまんで引っぱる。ほとんど動かさずに離したら「押した」
  const down = (id: string) => (e: React.PointerEvent) => {
    const b = bodies.current.get(id);
    const r = box.current?.getBoundingClientRect();
    if (!b || !r) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { id, dx: b.x - (e.clientX - r.left), dy: b.y - (e.clientY - r.top), moved: false, sx: e.clientX, sy: e.clientY };
    b.pinned = true;
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    const r = box.current?.getBoundingClientRect();
    if (!d || !r) return;
    if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 5) d.moved = true;
    const b = bodies.current.get(d.id);
    if (b) {
      b.x = e.clientX - r.left + d.dx;
      b.y = e.clientY - r.top + d.dy;
    }
  };
  const up = (n: GNode) => () => {
    const d = drag.current;
    drag.current = null;
    const b = bodies.current.get(n.id);
    if (b) b.pinned = false;
    if (!d || d.moved) return;
    if (n.kind === "task" && focus === n.id) location.hash = `#/task/${encodeURIComponent(n.task!.id)}`;
    else setFocus((f) => (f === n.id ? null : n.id));
  };

  const lit = focus ?? hover;
  const near = useMemo(() => {
    if (!lit) return null;
    const s = new Set([lit]);
    for (const e of edges) {
      if (e.a === lit) s.add(e.b);
      if (e.b === lit) s.add(e.a);
    }
    return s;
  }, [lit, edges]);
  const dim = (id: string) => (near && !near.has(id) ? "opacity-25" : "opacity-100");
  const focused = focus ? nodes.find((n) => n.id === focus) : null;

  return (
    <div className="mx-4 mt-2 overflow-hidden rounded-2xl border border-line bg-panel-2" aria-label="オーケストレーション">
      <style>{"@keyframes gh-flow{to{stroke-dashoffset:-20}}@keyframes gh-breathe{0%,100%{transform:scale(1);opacity:.55}50%{transform:scale(1.35);opacity:0}}@media (prefers-reduced-motion:reduce){.gh-anim{animation:none!important}}"}</style>
      <div ref={box} className="relative h-[300px] touch-none select-none md:h-[380px]" onPointerMove={move} onClick={(e) => e.target === e.currentTarget && setFocus(null)}>
        <svg className="pointer-events-none absolute inset-0 size-full" aria-hidden="true">
          {edges.map((e) => {
            const on = !near || (near.has(e.a) && near.has(e.b));
            return (
              <line
                key={`${e.a}>${e.b}`}
                ref={(el) => void (el ? edgeEls.current.set(`${e.a}>${e.b}`, el) : edgeEls.current.delete(`${e.a}>${e.b}`))}
                stroke={e.live ? "var(--color-ring-lime)" : e.watch ? "#B8A1FF" : "var(--color-track)"}
                strokeWidth={e.b.startsWith("t:") ? 1 : 1.6}
                strokeDasharray={e.live ? "6 4" : e.watch ? "2 4" : undefined}
                strokeLinecap={e.watch ? "round" : undefined}
                className={`gh-anim transition-opacity duration-300 ${on ? "opacity-100" : "opacity-15"}`}
                style={e.live ? { animation: "gh-flow 1.1s linear infinite" } : undefined}
              />
            );
          })}
        </svg>
        {nodes.map((n) => {
          const common = {
            ref: (el: HTMLDivElement | null) => void (el ? nodeEls.current.set(n.id, el) : nodeEls.current.delete(n.id)),
            onPointerDown: down(n.id),
            onPointerUp: up(n),
            onPointerEnter: (e: React.PointerEvent) => e.pointerType === "mouse" && setHover(n.id),
            onPointerLeave: () => setHover((h) => (h === n.id ? null : h)),
          };
          if (n.kind === "task") {
            const t = n.task!;
            const show = near?.has(n.id) && (lit === n.id || lit === edges.find((e) => e.b === n.id)?.a);
            return (
              <div key={n.id} {...common} role="button" aria-label={`カード ${t.title}（${t.status}）`} className={`absolute left-0 top-0 cursor-grab transition-opacity duration-300 ${dim(n.id)}`}>
                <span className="block rounded-full" style={{ width: n.r * 2, height: n.r * 2, background: TASK_DOT[t.status] ?? "var(--color-line-2)" }} />
                {show && <span className="pointer-events-none absolute left-1/2 top-full mt-0.5 max-w-[120px] -translate-x-1/2 truncate whitespace-nowrap rounded bg-panel/90 px-1 text-[10px] text-ink-2">{t.title}</span>}
              </div>
            );
          }
          const a = n.agent;
          const p = a ?? { id: "me", name: ownerName(), initial: [...ownerName()][0] ?? "?", color: "var(--color-me)" };
          return (
            <div key={n.id} {...common} role="button" aria-label={a ? `${a.name}（${STATE_LABEL[a.state]}）` : ownerName()} className={`absolute left-0 top-0 cursor-grab transition-opacity duration-300 ${dim(n.id)}`}>
              <span className="relative block">
                {a?.state === "running" && <span className="gh-anim absolute inset-0 rounded-full" style={{ background: "var(--color-ring-lime)", animation: "gh-breathe 2.2s ease-in-out infinite" }} />}
                <span className="relative block">
                  <Avatar p={p} size={n.r * 2} ring={a ? STATE_RING[a.state] : undefined} />
                </span>
              </span>
              <span className="pointer-events-none absolute left-1/2 top-full mt-0.5 flex -translate-x-1/2 flex-col items-center leading-tight">
                <span className="whitespace-nowrap text-[11px] font-semibold">{p.name}</span>
                {/* 役割（名前の下）。動いている・止まっているときだけ、その印を前に */}
                {a && (
                  <span className="flex items-center gap-1 whitespace-nowrap text-[9.5px] text-mute">
                    {a.state !== "idle" && <span className="size-1.5 rounded-full" style={{ background: STATE_TEXT[a.state] }} title={STATE_LABEL[a.state]} />}
                    {a.role ?? STATE_LABEL[a.state]}
                  </span>
                )}
              </span>
            </div>
          );
        })}
      </div>
      <div className="flex min-h-9 items-center gap-3 border-t border-line px-3 text-[11px] text-mute">
        {focused?.agent ? (
          <span className="truncate">
            <b className="text-ink">{focused.agent.name}</b>　実行中 {focused.agent.running}・停止 {focused.agent.blocked}・待ち {focused.agent.ready}
          </span>
        ) : focused?.task ? (
          <a href={`#/task/${encodeURIComponent(focused.task.id)}`} className="min-w-0 truncate text-ink-2">{focused.task.title} ›</a>
        ) : (
          <>
            <span className="flex items-center gap-1 whitespace-nowrap"><span className="size-2 rounded-full" style={{ background: TASK_DOT.running }} />実行中</span>
            <span className="flex items-center gap-1 whitespace-nowrap"><span className="size-2 rounded-full" style={{ background: TASK_DOT.blocked }} />停止</span>
            <span className="flex items-center gap-1 whitespace-nowrap"><span className="size-2 rounded-full bg-line-2" />待ち</span>
            <span className="flex items-center gap-1 whitespace-nowrap"><span className="w-3 border-t-2 border-dotted" style={{ borderColor: "#B8A1FF" }} />監察</span>
            <span className="ml-auto hidden truncate sm:inline">点を押すと、つながりだけ出す</span>
          </>
        )}
      </div>
    </div>
  );
}
