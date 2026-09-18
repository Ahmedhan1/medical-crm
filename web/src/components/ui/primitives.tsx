import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';
import './ui.css';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  loading?: boolean;
}
export function Button({
  variant = 'primary',
  loading = false,
  disabled,
  children,
  className,
  ...rest
}: ButtonProps): JSX.Element {
  return (
    <button
      className={`mc-btn mc-btn--${variant}${className ? ` ${className}` : ''}`}
      disabled={disabled ?? loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading && <span className="mc-spinner" aria-hidden="true" />}
      {children}
    </button>
  );
}

export type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';
export function Badge({ tone = 'neutral', children }: { tone?: BadgeTone; children: ReactNode }) {
  return <span className={`mc-badge mc-badge--${tone}`}>{children}</span>;
}

export type AlertTone = 'info' | 'success' | 'warning' | 'danger';
export function Alert({
  tone = 'info',
  title,
  children,
  role = 'status',
}: {
  tone?: AlertTone;
  title?: string;
  children?: ReactNode;
  role?: 'status' | 'alert';
}) {
  return (
    <div className={`mc-alert mc-alert--${tone}`} role={role}>
      <div>
        {title && <strong>{title}</strong>}
        {title && children ? <div>{children}</div> : children}
      </div>
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span role="status" aria-live="polite" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <span className="mc-spinner" aria-hidden="true" />
      {label && <span className="mc-visually-hidden">{label}</span>}
    </span>
  );
}

export function Skeleton({
  width = '100%',
  height = 16,
  radius,
}: {
  width?: number | string;
  height?: number | string;
  radius?: number | string;
}) {
  return (
    <span
      className="mc-skeleton"
      aria-hidden="true"
      style={{ display: 'block', width, height, borderRadius: radius }}
    />
  );
}

export function Card({
  title,
  children,
  ...rest
}: { title?: ReactNode; children: ReactNode } & HTMLAttributes<HTMLDivElement>) {
  return (
    <section className="mc-card" {...rest}>
      {title && <header className="mc-card__header">{title}</header>}
      <div className="mc-card__body">{children}</div>
    </section>
  );
}
