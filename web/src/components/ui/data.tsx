import type { ReactNode } from 'react';
import './ui.css';

/** Generic, typed data table. Columns render from row objects; no domain logic. */
export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
}
export function Table<T>({
  columns,
  rows,
  rowKey,
  empty,
}: {
  columns: Array<Column<T>>;
  rows: T[];
  rowKey: (row: T, index: number) => string;
  empty?: ReactNode;
}): JSX.Element {
  if (rows.length === 0 && empty) return <>{empty}</>;
  return (
    <div className="mc-table-wrap">
      <table className="mc-table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col">
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={rowKey(row, i)}>
              {columns.map((c) => (
                <td key={c.key}>{c.render(row)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export interface TabItem {
  id: string;
  label: ReactNode;
}
export function Tabs({
  items,
  active,
  onChange,
}: {
  items: TabItem[];
  active: string;
  onChange: (id: string) => void;
}): JSX.Element {
  return (
    <div className="mc-tabs">
      <div className="mc-tabs__list" role="tablist">
        {items.map((it) => (
          <button
            key={it.id}
            role="tab"
            type="button"
            aria-selected={active === it.id}
            className="mc-tab"
            onClick={() => onChange(it.id)}
          >
            {it.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function EmptyState({ title, body }: { title: string; body?: ReactNode }) {
  return (
    <div className="mc-state">
      <div className="mc-state__title">{title}</div>
      {body && <div>{body}</div>}
    </div>
  );
}

export function ErrorState({
  title,
  body,
  onRetry,
  retryLabel = 'Retry',
}: {
  title: string;
  body?: ReactNode;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <div className="mc-state" role="alert">
      <div className="mc-state__title">{title}</div>
      {body && <div>{body}</div>}
      {onRetry && (
        <button className="mc-btn mc-btn--secondary" onClick={onRetry} style={{ marginBlockStart: 8 }}>
          {retryLabel}
        </button>
      )}
    </div>
  );
}

export function Pagination({
  page,
  pageCount,
  onChange,
  labels,
}: {
  page: number;
  pageCount: number;
  onChange: (page: number) => void;
  labels: { previous: string; next: string; page: string; of: string };
}): JSX.Element {
  return (
    <nav className="mc-pagination" aria-label="pagination">
      <button
        className="mc-btn mc-btn--secondary"
        disabled={page <= 1}
        onClick={() => onChange(page - 1)}
      >
        {labels.previous}
      </button>
      <span aria-live="polite">
        {labels.page} {page} {labels.of} {Math.max(pageCount, 1)}
      </span>
      <button
        className="mc-btn mc-btn--secondary"
        disabled={page >= pageCount}
        onClick={() => onChange(page + 1)}
      >
        {labels.next}
      </button>
    </nav>
  );
}
