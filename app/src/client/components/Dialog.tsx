import { useEffect, useId, useRef, type ReactNode } from 'react';

interface Props {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer: ReactNode;
}

// A native <dialog>: it traps focus, closes on Escape, and is announced as a dialog.
// Focus starts on the element marked data-autofocus, so a confirm opens on the safe choice.
export function Dialog({ open, onClose, title, children, footer }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      d.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    }
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={() => {
        // The browser puts focus back on the button that opened the dialog. When the choice
        // turned that button off, removed it, or moved to another page, focus would drop to
        // <body>: give it to the visible page's heading instead.
        if (!document.activeElement || document.activeElement === document.body) {
          document.querySelector<HTMLElement>('[data-page]:not([hidden]) h1')?.focus({ preventScroll: true });
        }
        onClose();
      }}
      // A click on the backdrop lands on the <dialog> itself; clicks inside land on children.
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      {open && (
        <div className="dialog-inner">
          <h2 id={titleId}>{title}</h2>
          <div className="dialog-body">{children}</div>
          <div className="dialog-foot">{footer}</div>
        </div>
      )}
    </dialog>
  );
}
