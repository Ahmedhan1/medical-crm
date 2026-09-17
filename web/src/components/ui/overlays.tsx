import { useEffect, type ReactNode } from 'react';
import './ui.css';

function useEscapeToClose(open: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);
}

interface OverlayProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  /** Accessible label for the close button (localized by the caller). */
  closeLabel?: string;
}

export function Dialog({ open, onClose, title, children, closeLabel = 'Close' }: OverlayProps) {
  useEscapeToClose(open, onClose);
  if (!open) return null;
  return (
    <div className="mc-scrim" onMouseDown={onClose}>
      <div
        className="mc-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mc-overlay__header">
          <span>{title}</span>
          <button className="mc-btn mc-btn--ghost" onClick={onClose} aria-label={closeLabel}>
            ✕
          </button>
        </div>
        <div className="mc-overlay__body">{children}</div>
      </div>
    </div>
  );
}

export function Drawer({ open, onClose, title, children, closeLabel = 'Close' }: OverlayProps) {
  useEscapeToClose(open, onClose);
  if (!open) return null;
  return (
    <div className="mc-scrim" style={{ padding: 0 }} onMouseDown={onClose}>
      <div
        className="mc-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mc-overlay__header">
          <span>{title}</span>
          <button className="mc-btn mc-btn--ghost" onClick={onClose} aria-label={closeLabel}>
            ✕
          </button>
        </div>
        <div className="mc-overlay__body">{children}</div>
      </div>
    </div>
  );
}
