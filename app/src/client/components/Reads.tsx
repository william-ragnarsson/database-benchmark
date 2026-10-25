import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { ENGINE_LABEL, fmtMs } from '../format';
import { LEAD_MS, SCENES, SLOW_MS, plan, type Cell, type Data, type Plan, type Side, type Value } from '../scenes';
import type { Engine, RunResult, Status } from '../../shared/types';

const ENGINES: Engine[] = ['pg', 'ch'];

// One loop: draw, hold the end frame, fade out, a short blank, then draw again.
const READ_MS = 450; // .reads-table i.r and i.h in styles.css
const HOLD_MS = 1500;
const FADE_MS = 400; // .reads-table i
const BLANK_MS = 200;
const DRAW_MS = LEAD_MS + SLOW_MS + READ_MS + HOLD_MS;
// Below this, a "starting…" label would only flicker.
const STARTING_MIN_MS = 400;
// Narrower than this, the widest tables would cut off their text, so the columns the query
// doesn't need fold into one.
const NARROW_PX = 780;
// Columns the query needs keep their full width if they're this many characters wide or fewer.
const SHORT_CHARS = 8;
// The card plays once this much of it is on screen, or this much of the screen if it's taller.
const IN_VIEW = 0.3;
// An entry every 1%, so one comes soon after the card crosses IN_VIEW, whatever its height.
const THRESHOLDS = Array.from({ length: 101 }, (_, i) => i / 100);

interface Props {
  result: RunResult;
  // The data the result was measured on, and each engine's fixed cost.
  data: Data | null;
  baselineMs: Status['baselineMs'];
  // Something else is going on (another tab's run, a reseed): hold the end frame.
  paused: boolean;
}

// play: drawing. end: the finished picture, held on purpose. wait: out of view, so nothing is
// lit; the picture shouldn't be seen finished just before it's drawn.
type Mode = 'play' | 'end' | 'wait';

// Below the result: a few rows of the query's table, lit cell by cell as each engine reads
// them, with the faster engine finishing first. It loops while in view.
export function Reads({ result, data, baselineMs, paused }: Props) {
  const scene = result.templateId ? SCENES[result.templateId] : undefined;
  const ref = useRef<HTMLElement>(null);
  const panels = useRef<HTMLDivElement>(null);
  const narrow = useNarrow(panels);
  const p = useMemo(
    () => scene && data && plan(scene, result, baselineMs, data, narrow),
    [scene, result, baselineMs, data, narrow],
  );
  const { inView, onScreen } = useVisible(ref);
  const reduced = useReducedMotion();
  const [playing, setPlaying] = useState(true);
  // Pressing Play or Replay plays the drawing however little of it is on screen, until it's off.
  const [pressed, setPressed] = useState(false);
  const [loop, setLoop] = useState({ n: 0, out: false });
  const held = !playing || paused || reduced;
  const animate = !!p && (inView || (pressed && onScreen)) && !held;
  const mode: Mode = animate ? 'play' : held ? 'end' : 'wait';

  useEffect(() => {
    if (!onScreen) setPressed(false);
  }, [onScreen]);

  useEffect(() => {
    if (!animate) return;
    // Back in view after a fade-out: start a fresh loop.
    setLoop((l) => (l.out ? { n: l.n + 1, out: false } : l));
    const fade = setTimeout(() => setLoop((l) => ({ ...l, out: true })), DRAW_MS);
    const next = setTimeout(() => setLoop((l) => ({ n: l.n + 1, out: false })), DRAW_MS + FADE_MS + BLANK_MS);
    return () => {
      clearTimeout(fade);
      clearTimeout(next);
    };
  }, [animate, loop.n, narrow]);

  if (!p) return null;
  // A new key restarts every CSS animation in the drawing, and so does a new layout.
  const loopKey = `${narrow ? 'n' : 'w'}-${animate ? loop.n : mode}`;

  return (
    <section ref={ref} className={`card reads${mode === 'wait' ? ' reads-wait' : ''}`} aria-labelledby="reads-title">
      <div className="reads-head">
        <h2 id="reads-title">What each engine reads</h2>
        {/* Off while something else holds the drawing; the reason shows under the Run button.
            aria-disabled, not hidden: hiding it would drop focus to <body>. */}
        {!reduced && (
          <button
            type="button"
            className="card-toggle"
            aria-label={`${TOGGLE[mode]} the animation`}
            aria-disabled={paused || undefined}
            onClick={() => {
              if (paused) return;
              if (mode === 'play') return setPlaying(false);
              setPlaying(true);
              setPressed(true);
            }}
          >
            {TOGGLE[mode]}
          </button>
        )}
      </div>
      <p className="reads-intro">
        A few rows of {p.table}, lit as each engine reads them. Darker cells are what the query needs.
      </p>
      <div ref={panels} className="reads-panels">
        {ENGINES.map((e) => (
          <div key={e} className="reads-panel">
            <p className="reads-label">
              <span className={`reads-name ${e}-ink`}>{ENGINE_LABEL[e]}</span>
              {/* The times are in the result above; here they only mark when each engine is done. */}
              <span
                key={loopKey}
                className={`reads-time${result.headline.winner === e ? ` win ${e}-ink` : ''}`}
                aria-hidden
              >
                {mode === 'play' && p[e].wait >= STARTING_MIN_MS && (
                  <span className="reads-starting" style={{ animationDelay: ms(LEAD_MS + p[e].wait) }}>
                    starting…
                  </span>
                )}
                <span
                  className={mode === 'play' ? 'reads-median' : undefined}
                  style={mode === 'play' ? { animationDelay: ms(LEAD_MS + p[e].d) } : undefined}
                >
                  {fmtMs(result.engines[e].medianMs)}
                </span>
              </span>
            </p>
            <Table
              key={loopKey}
              engine={e}
              plan={p}
              side={p[e]}
              mode={mode}
              out={animate && loop.out}
              narrow={narrow}
            />
            <p className="reads-caption">{p[e].caption}</p>
          </div>
        ))}
      </div>
      {p.note && <p className="reads-note">{p.note}</p>}
    </section>
  );
}

interface TableProps {
  engine: Engine;
  plan: Plan;
  side: Side;
  mode: Mode;
  out: boolean;
  narrow: boolean;
}

const ms = (n: number) => `${Math.round(n)}ms`;
const TOGGLE: Record<Mode, string> = { play: 'Stop', end: 'Replay', wait: 'Play' };

function Table({ engine, plan: p, side, mode, out, narrow }: TableProps) {
  const play = mode === 'play';
  const cells = new Map(side.cells.map((cell) => [`${cell.r}-${cell.c}`, cell]));
  const skipped = new Set(side.skipped);
  // Each column gets its share of the width by how many characters it holds, plus its padding.
  // Short ones the query needs (ids, prices, quantity) and "+N" never shrink, so a squeeze cuts
  // the long text and the columns the query doesn't need instead.
  const columns = p.columns
    .map((col) => {
      const keep = col.width <= SHORT_CHARS && (col.used || col.more);
      return `minmax(${keep ? `calc(${col.width}ch + 2 * var(--cell-x))` : 0}, ${col.width + 1.5}fr)`;
    })
    .join(' ');
  // Skipped rows fade once the engine is done, and come back as the loop fades out.
  const skip = mode === 'wait' ? undefined : play ? (out ? 'skip undim' : 'skip') : 'skip end';
  return (
    <div
      className={`reads-table reads-${engine}${out ? ' out' : ''}${narrow ? ' reads-narrow' : ''}`}
      style={{ gridTemplateColumns: columns }}
      aria-hidden
    >
      {p.columns.map((col) => (
        <span key={col.name} className={`reads-th${col.used ? ' used' : ''}`} title={col.more?.join(', ')}>
          {/* A zero-width space after each underscore lets a narrow header wrap there. */}
          {narrow ? col.name.replaceAll('_', '_​') : col.name}
        </span>
      ))}
      {p.rows.map((row, r) =>
        row.map((value, c) => {
          const cell = cells.get(`${r}-${c}`);
          const rowSkipped = skip && skipped.has(r);
          return (
            <span
              key={`${r}-${c}`}
              className={rowSkipped ? skip : undefined}
              style={rowSkipped && skip === 'skip' ? { animationDelay: ms(LEAD_MS + side.d) } : undefined}
            >
              {cell && <Lit cell={cell} play={play} />}
              <Text value={value} />
            </span>
          );
        }),
      )}
    </div>
  );
}

// A cell's highlight: faint once read, darker if the query needs it.
function Lit({ cell, play }: { cell: Cell; play: boolean }) {
  if (!play) return <i className={cell.hit === null ? 'r end' : 'h end'} />;
  if (cell.hit === null) return <i className="r" style={{ animationDelay: ms(cell.at) }} />;
  if (cell.hit === cell.at) return <i className="h" style={{ animationDelay: ms(cell.at) }} />;
  return <i className="rh" style={{ animationDelay: `${ms(cell.at)}, ${ms(cell.hit)}` }} />;
}

function Text({ value }: { value: Value }) {
  if (!value.mark) return value.text;
  const [from, to] = value.mark;
  return (
    <>
      {value.text.slice(0, from)}
      <u>{value.text.slice(from, to)}</u>
      {value.text.slice(to)}
    </>
  );
}

// True while the element is narrower than NARROW_PX, measured before the first paint. A
// hidden page measures 0 wide, so that keeps the last answer.
function useNarrow(ref: RefObject<HTMLElement | null>): boolean {
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = (width: number) => {
      if (width > 0) setNarrow(width < NARROW_PX);
    };
    update(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => update(entries[entries.length - 1].contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return narrow;
}

// onScreen: some of the element is on screen and the browser tab is showing. inView: enough of
// it is, by IN_VIEW.
function useVisible(ref: RefObject<HTMLElement | null>): { inView: boolean; onScreen: boolean } {
  const [inView, setInView] = useState(false);
  const [onScreen, setOnScreen] = useState(false);
  const [shown, setShown] = useState(() => !document.hidden);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      setInView(true);
      setOnScreen(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        // Entries come oldest first, so the last one is where the element is now.
        const e = entries[entries.length - 1];
        const room = Math.min(e.boundingClientRect.height, e.rootBounds?.height ?? Infinity);
        setOnScreen(e.isIntersecting);
        setInView(e.isIntersecting && e.intersectionRect.height >= IN_VIEW * room);
      },
      { threshold: THRESHOLDS },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  useEffect(() => {
    const onChange = () => setShown(!document.hidden);
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);
  return { inView: inView && shown, onScreen: onScreen && shown };
}

function useReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)';
  const [reduced, setReduced] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const mq = matchMedia(query);
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}
