import { DataClass, type DataClass as DataClassType } from '../classification.js';
import { RiskClass } from './risk.js';

/**
 * AI Tool Registry (E4).
 *
 * A CODE registry (not user data): every tool an AI could ever invoke is
 * declared here with explicit metadata. Because it is code, an AI caller cannot
 * invent a tool name and have it execute — an unknown id resolves to `undefined`
 * and the Action Guard fails closed.
 *
 * A tool's `handler` is optional: authorization-only entries (no handler) shape
 * the registry and the prohibited set without granting any capability. Real
 * executable tools that would read another workstream's data must be added by
 * that workstream via a CCR — never wired from here.
 */
export interface AiToolContext {
  clinicId: string;
  identityId: string;
  requestId: string;
  actorId?: string | null;
}

export type AiToolHandler = (ctx: AiToolContext, args: Record<string, unknown>) => Promise<unknown>;

export interface AiTool {
  id: string;
  name: string;
  description: string;
  access: 'read' | 'write';
  /** AI-scope required to use this tool (a vocabulary distinct from human RBAC). */
  requiredScope: string;
  /** Highest data classification this tool is permitted to touch. */
  dataCeiling: DataClassType;
  risk: RiskClass;
  /** Force human confirmation regardless of risk default. */
  requiresConfirmation: boolean;
  enabled: boolean;
  /** Absent ⇒ authorization-only (execution returns `no_handler`, never runs). */
  handler?: AiToolHandler;
}

const registry = new Map<string, AiTool>();

export function registerTool(tool: AiTool): void {
  registry.set(tool.id, tool);
}

export function getTool(id: string): AiTool | undefined {
  return registry.get(id);
}

export function listTools(): AiTool[] {
  return [...registry.values()].map((t) => ({ ...t }));
}

// ---------------------------------------------------------------------------
// Built-in tools
// ---------------------------------------------------------------------------

/** Non-destructive mock tools used to exercise the kernel (no real side effects). */
const BUILTIN_EXECUTABLE: AiTool[] = [
  {
    id: 'demo.echo',
    name: 'Echo (diagnostic)',
    description: 'Returns a fixed acknowledgement. Non-destructive; for kernel diagnostics.',
    access: 'read',
    requiredScope: 'ai:demo-read',
    dataCeiling: DataClass.INTERNAL,
    risk: RiskClass.READ_ONLY,
    requiresConfirmation: false,
    enabled: true,
    handler: async () => ({ pong: true }),
  },
  {
    id: 'demo.write_note',
    name: 'Write demo note',
    description: 'Mock low-risk write. Performs no real mutation; for kernel tests.',
    access: 'write',
    requiredScope: 'ai:demo-write',
    dataCeiling: DataClass.OPERATIONAL,
    risk: RiskClass.LOW_RISK,
    requiresConfirmation: false,
    enabled: true,
    handler: async () => ({ written: true }),
  },
  {
    id: 'demo.reschedule',
    name: 'Reschedule (demo)',
    description: 'Mock medium-risk action requiring human confirmation. No real mutation.',
    access: 'write',
    requiredScope: 'ai:demo-write',
    dataCeiling: DataClass.OPERATIONAL,
    risk: RiskClass.MEDIUM_RISK,
    requiresConfirmation: true,
    enabled: true,
    handler: async () => ({ rescheduled: true }),
  },
];

/**
 * Authorization-only READ tools. Declared so the guard can reason about them;
 * their real handlers (which would read another workstream's data) must be
 * provided by the owning workstream via a CCR, never from Agent 3.
 */
const BUILTIN_READONLY_UNIMPLEMENTED: AiTool[] = [
  ro('patient.search', 'Search patients', 'read:patient'),
  ro('appointment.read', 'Read appointments', 'read:appointment'),
  ro('report.read', 'Read operational reports', 'read:report'),
];

function ro(id: string, name: string, scope: string): AiTool {
  return {
    id,
    name,
    description: `${name} (authorization-only; handler provided by the owning workstream via CCR).`,
    access: 'read',
    requiredScope: scope,
    dataCeiling: DataClass.PHI,
    risk: RiskClass.READ_ONLY,
    requiresConfirmation: false,
    enabled: true,
    // no handler — authorization can succeed but execution yields `no_handler`.
  };
}

/**
 * Clinical operations AI must NEVER perform autonomously. Registered as
 * PROHIBITED with no handler, so the guard denies them unconditionally and no
 * clinical mutation code exists in Agent 3. (The clinical system is Agent 2's.)
 */
export const PROHIBITED_CLINICAL_TOOL_IDS = [
  'clinical.diagnosis.create',
  'clinical.diagnosis.modify',
  'clinical.prescription.create',
  'clinical.prescription.modify',
  'clinical.prescription.cancel',
  'clinical.note.sign',
  'clinical.encounter.close',
  'clinical.allergy.modify',
  'clinical.observation.modify',
  'clinical.record.delete',
] as const;

function prohibited(id: string): AiTool {
  return {
    id,
    name: id,
    description: 'Clinical mutation AI may never perform autonomously. Structurally denied.',
    access: 'write',
    requiredScope: 'prohibited',
    dataCeiling: DataClass.HIGHLY_RESTRICTED,
    risk: RiskClass.PROHIBITED,
    requiresConfirmation: true,
    enabled: false, // also disabled; PROHIBITED denies first regardless
  };
}

function seedBuiltins(): void {
  registry.clear();
  for (const t of BUILTIN_EXECUTABLE) registry.set(t.id, t);
  for (const t of BUILTIN_READONLY_UNIMPLEMENTED) registry.set(t.id, t);
  for (const id of PROHIBITED_CLINICAL_TOOL_IDS) registry.set(id, prohibited(id));
}
seedBuiltins();

/** Restore the registry to only the built-in tools (test isolation). */
export function resetToolRegistry(): void {
  seedBuiltins();
}
