/**
 * AI action risk classes (E4). Risk is an EXPLICIT, structural input to the
 * authorization decision — never inferred from a tool's name or description.
 *
 * Ordered least→most dangerous. PROHIBITED is a terminal class: a PROHIBITED
 * tool is denied unconditionally (used to structurally block clinical mutations
 * AI must never perform autonomously).
 */
export const RiskClass = {
  READ_ONLY: 'read_only',
  LOW_RISK: 'low_risk',
  MEDIUM_RISK: 'medium_risk',
  HIGH_RISK: 'high_risk',
  PROHIBITED: 'prohibited',
} as const;

export type RiskClass = (typeof RiskClass)[keyof typeof RiskClass];

const RISK_SEVERITY: Record<RiskClass, number> = {
  [RiskClass.READ_ONLY]: 0,
  [RiskClass.LOW_RISK]: 1,
  [RiskClass.MEDIUM_RISK]: 2,
  [RiskClass.HIGH_RISK]: 3,
  [RiskClass.PROHIBITED]: 99, // never reachable by any identity ceiling
};

export function riskSeverity(risk: RiskClass): number {
  return RISK_SEVERITY[risk];
}

/** Identity risk ceilings — the four non-terminal classes an identity may hold. */
export type RiskCeiling = 'read_only' | 'low_risk' | 'medium_risk' | 'high_risk';

/** Can an identity whose ceiling is `ceiling` perform an action of class `risk`? */
export function riskWithinCeiling(risk: RiskClass, ceiling: RiskCeiling): boolean {
  if (risk === RiskClass.PROHIBITED) return false; // never, regardless of ceiling
  return riskSeverity(risk) <= riskSeverity(ceiling);
}

/**
 * Whether an action of this risk requires a human confirmation by default.
 * MEDIUM_RISK and above require confirmation; a tool may additionally opt in.
 */
export function riskRequiresConfirmation(risk: RiskClass): boolean {
  return riskSeverity(risk) >= riskSeverity(RiskClass.MEDIUM_RISK) && risk !== RiskClass.PROHIBITED;
}
