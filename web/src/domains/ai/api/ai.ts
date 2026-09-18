import { api } from '../../../lib/api/client.js';

/**
 * AI domain API layer — thin typed wrappers over the EXISTING review-first AI
 * endpoints. Every generation returns a DRAFT; confirming a draft is a human
 * review action that does NOT write clinical data (CCR-001). The backend is the
 * sole authority (RBAC/tenant/gateway re-checked per call); these types mirror it.
 */

export type DraftKind = 'intake' | 'summary' | 'call_report' | 'clinical_note';
export type DraftStatus = 'pending' | 'confirmed' | 'rejected';
export interface Citation { ref: string; kind: string; quote?: string }

export interface AIDraft {
  id: string;
  kind: DraftKind;
  subjectType: string;
  subjectId: string;
  status: DraftStatus;
  content: Record<string, unknown>;
  citations: Citation[];
  provider: string;
  model: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  createdAt: string;
  updatedAt: string;
}

export function listDrafts(filter: { status?: DraftStatus; kind?: DraftKind } = {}, signal?: AbortSignal): Promise<AIDraft[]> {
  const query: Record<string, string> = {};
  if (filter.status) query.status = filter.status;
  if (filter.kind) query.kind = filter.kind;
  return api.get<{ drafts: AIDraft[] }>('/ai/drafts', { query, signal }).then((r) => r.drafts);
}
export function getDraft(id: string, signal?: AbortSignal): Promise<AIDraft> {
  return api.get<AIDraft>(`/ai/drafts/${id}`, { signal });
}
export function confirmDraft(id: string, note?: string): Promise<AIDraft> {
  return api.post<AIDraft>(`/ai/drafts/${id}/confirm`, note ? { note } : {});
}
export function rejectDraft(id: string, note?: string): Promise<AIDraft> {
  return api.post<AIDraft>(`/ai/drafts/${id}/reject`, note ? { note } : {});
}

export interface CreateIntakeBody {
  subjectType: 'patient' | 'encounter';
  subjectId: string;
  text?: string;
  locale?: string;
}
export function createIntakeDraft(body: CreateIntakeBody): Promise<AIDraft> {
  return api.post<AIDraft>('/ai/intake', body);
}
export function generateSummary(patientId: string): Promise<AIDraft> {
  return api.post<AIDraft>(`/ai/summaries/patient/${patientId}`);
}

// --- Receptionist (administrative only; escalates clinical) ---------------
export interface ReceptionistResponse {
  requestId: string;
  intent: string;
  category: 'administrative' | 'clinical' | 'other';
  escalate: boolean;
  escalateTo: 'clinical_staff' | 'reception_staff' | null;
  action: 'answer' | 'route_to_staff' | 'escalate_clinical';
  reply: string;
  mutating: false;
}
export function askReceptionist(text: string): Promise<ReceptionistResponse> {
  return api.post<ReceptionistResponse>('/ai/receptionist', { text });
}

// --- Evaluation health ----------------------------------------------------
export interface EvalReport { suite: string; provider: string; model?: string; total: number; passed: number; failed: number; avgLatencyMs: number }
export interface EvalRunResult { intake: EvalReport; summary: EvalReport; runIds: string[] }
export interface EvalRunRow { id: string; suite: string; provider: string; model: string | null; total: number; passed: number; failed: number; avgLatencyMs: number | null; createdAt: string }

export function runEval(): Promise<EvalRunResult> {
  return api.post<EvalRunResult>('/ai/eval/run');
}
export function listEvalRuns(signal?: AbortSignal): Promise<EvalRunRow[]> {
  return api.get<{ runs: EvalRunRow[] }>('/ai/eval/runs', { signal }).then((r) => r.runs);
}
