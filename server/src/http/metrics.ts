/**
 * Minimal in-process metrics (Task 4). PHI-safe by construction: labels are
 * bounded-cardinality operational values only — HTTP method, the ROUTE TEMPLATE
 * (e.g. `/patients/:id`, never the concrete path with ids), and a status class
 * (`2xx`/`4xx`/`5xx`). No patient id, name, query value, or free text is ever a
 * label. No dependency — a plain counter map.
 */
type Key = string;

interface Snapshot {
  requestsTotal: Record<Key, number>;
  errorsTotal: number;
  startedAt: string;
}

const requests = new Map<Key, number>();
let errorsTotal = 0;
const startedAt = new Date().toISOString();

function statusClass(status: number): string {
  if (status >= 500) return '5xx';
  if (status >= 400) return '4xx';
  if (status >= 300) return '3xx';
  return '2xx';
}

/** Record one completed request. `routeTemplate` MUST be the template, not the path. */
export function recordRequest(method: string, routeTemplate: string | undefined, status: number): void {
  // The route TEMPLATE (Fastify `routeOptions.url`, e.g. `/patients/:id`) is
  // bounded cardinality. When there is no match (404s) there is no template, so
  // bucket as 'unmatched' rather than storing the concrete, possibly id-bearing path.
  const tmpl = routeTemplate && routeTemplate.length > 0 ? routeTemplate : 'unmatched';
  const key = `${method} ${tmpl} ${statusClass(status)}`;
  requests.set(key, (requests.get(key) ?? 0) + 1);
  if (status >= 500) errorsTotal += 1;
}

export function metricsSnapshot(): Snapshot {
  return {
    requestsTotal: Object.fromEntries([...requests.entries()].sort()),
    errorsTotal,
    startedAt,
  };
}

/** Test helper. */
export function resetMetrics(): void {
  requests.clear();
  errorsTotal = 0;
}
