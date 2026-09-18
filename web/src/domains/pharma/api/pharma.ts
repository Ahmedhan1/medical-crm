import { api } from '../../../lib/api/client.js';

/**
 * Pharma API layer — drug master, approved scientific content, and the reporting
 * catalog. Thin typed wrappers over the existing pharma backend; the backend is
 * authoritative for RBAC/tenant/governance.
 */
export interface Medication {
  id: string;
  genericName: string;
  atcCode: string | null;
  therapeuticArea: string | null;
  verificationStatus: string;
}
export interface ApprovedContent {
  id: string;
  title: string;
  contentType: string;
  approvalStatus: string;
  jurisdiction: string;
}
export interface ReportDefinition {
  key: string;
  title: string;
  description: string;
}

export function listMedications(params: { q?: string }, signal?: AbortSignal): Promise<Medication[]> {
  return api.get<{ results: Medication[] }>('/medications', { query: { q: params.q, limit: 100 }, signal }).then((r) => r.results);
}
export function getMedication(id: string, signal?: AbortSignal): Promise<Medication & Record<string, unknown>> {
  return api.get<Medication & Record<string, unknown>>(`/medications/${id}`, { signal });
}
export function listContent(signal?: AbortSignal): Promise<ApprovedContent[]> {
  return api.get<{ results: ApprovedContent[] }>('/pharma/content', { signal }).then((r) => r.results);
}
export function listReports(signal?: AbortSignal): Promise<ReportDefinition[]> {
  return api.get<{ reports: ReportDefinition[] }>('/pharma/reports', { signal }).then((r) => r.reports);
}
