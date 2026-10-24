import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import indexJson from './recordings/index.json';

const REPO = 'https://github.com/william-ragnarsson/database-benchmark';

// The demo build's bubble, top right: the numbers are real, but recorded, not live. It grows
// into the full note while the pointer is on it or the keyboard is in it. A tap or click keeps
// it open until a click elsewhere or Escape, since touch screens have no hover.
export function DemoNote() {
  const day = new Date(indexJson.recordedAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const ref = useRef<HTMLElement>(null);
  const head = useRef<HTMLButtonElement>(null);
  const bodyId = useId();
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const open = pinned || hovered || focused;

  // The closed bubble is as wide as its label. Measured, so the width can animate.
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = head.current;
    if (!el) return;
    const measure = () => setWidth(el.offsetWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!pinned && !focused) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setPinned(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Back to the bubble first: a focused link in the closed note would lose focus.
      if (ref.current?.contains(document.activeElement)) head.current?.focus();
      setPinned(false);
      setFocused(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [pinned, focused]);

  return (
    <aside
      ref={ref}
      className="demo-note"
      aria-label="About this demo"
      data-open={open || undefined}
      style={width === null ? undefined : ({ '--pill-w': `${width + 2}px` } as CSSProperties)}
      onPointerEnter={(e) => {
        if (e.pointerType === 'mouse') setHovered(true);
      }}
      onPointerLeave={(e) => {
        if (e.pointerType === 'mouse') setHovered(false);
      }}
      // Only keyboard focus: a click focuses the button too, and pins it instead.
      onFocus={(e) => setFocused(e.target.matches(':focus-visible'))}
      onBlur={(e) => {
        if (!ref.current?.contains(e.relatedTarget)) setFocused(false);
      }}
    >
      <div className="demo-note-bubble">
        <button
          ref={head}
          type="button"
          className="demo-note-head"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setPinned((p) => !p)}
        >
          <svg width={18} height={18} viewBox="0 0 18 18" aria-hidden>
            <circle cx={9} cy={9} r={7.25} fill="none" stroke="currentColor" strokeWidth={1.5} />
            <path d="M9 8v4.5" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" />
            <circle cx={9} cy={5.5} r={1} fill="currentColor" />
          </svg>
          This is a demo
        </button>
        <div className="demo-note-body" id={bodyId} inert={!open}>
          <p>
            It takes up no disk space: the databases are simulated, but the timings are real, recorded once for every query
            and size on {day}, and replayed here. To run the queries yourself, <a href={REPO}>clone the repo</a> and start it
            with <code>docker compose up</code>.
          </p>
        </div>
      </div>
    </aside>
  );
}
