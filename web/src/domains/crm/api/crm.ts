import { api } from '../../../lib/api/client.js';

/**
 * CRM API layer — HCP/HCO relationship management + field visits. Thin typed
 * wrappers over the existing pharma backend (no invented endpoints). The backend
 * enforces RBAC + tenant + the §45 governance boundary (no patient data here).
 */
export type HcpStatus = 'active' | 'inactive' | 'retired' | 'merged';
export interface Hcp {
  id: string;
  fullName: string;
  title: string | null;
  professionalCategory: string;
  primarySpecialtyId: string | null;
  professionalEmail: string | null;
  professionalPhone: string | null;
  status: HcpStatus;
}
export interface Hco {
  id: string;
  name: string;
  hcoType: string;
  city: string | null;
  region: string | null;
  country: string;
  operatingStatus: string;
}
export type VisitStatus = 'planned' | 'confirmed' | 'completed' | 'cancelled' | 'no_access';
export interface Visit {
  id: string;
  hcpId: string | null;
  hcpName?: string;
  hcoId: string | null;
  hcoName?: string;
  modality: string;
  status: VisitStatus;
  visitType: string;
  plannedAt: string;
}

export function listHcps(params: { q?: string }, signal?: AbortSignal): Promise<Hcp[]> {
  return api.get<{ results: Hcp[] }>('/hcps', { query: { q: params.q, limit: 100 }, signal }).then((r) => r.results);
}
export function getHcp(id: string, signal?: AbortSignal): Promise<Hcp & Record<string, unknown>> {
  return api.get<Hcp & Record<string, unknown>>(`/hcps/${id}`, { signal });
}
export function listHcos(params: { q?: string }, signal?: AbortSignal): Promise<Hco[]> {
  return api.get<{ results: Hco[] }>('/hcos', { query: { q: params.q, limit: 100 }, signal }).then((r) => r.results);
}
export function listVisits(params: { status?: VisitStatus }, signal?: AbortSignal): Promise<Visit[]> {
  return api.get<{ visits: Visit[] }>('/visits', { query: { status: params.status }, signal }).then((r) => r.visits);
}
