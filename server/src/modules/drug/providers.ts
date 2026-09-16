/**
 * Medication data providers — the import architecture (blueprint §8).
 *
 * Two goals, both about not being trapped:
 *
 *  1. **No vendor lock-in.** The schema is provider-neutral: every product row
 *     carries `source`, `source_version`, `source_ref` and `license_basis`, so a
 *     provider can be replaced, re-imported or removed without a migration, and
 *     rows from different providers coexist.
 *  2. **No unlicensed ingestion.** A provider must be registered here with an
 *     explicit legal basis before data attributed to it can be written. Adding
 *     an entry is a licensing decision made by a human, not a code detail — and
 *     a provider whose terms forbid redistribution is marked as such.
 *
 * MEDCORE ships no third-party drug dataset. These entries describe how data
 * *may* be obtained by an operator, not data that is bundled.
 */
export interface MedicationProvider {
  key: string;
  displayName: string;
  /** The legal basis for holding data attributed to this provider. */
  licenseBasis: string;
  /** Whether the operator may redistribute the data onward. */
  redistributionAllowed: boolean;
  /** Jurisdictions the provider is meaningful for; empty means unrestricted. */
  jurisdictions: string[];
  notes: string;
}

export const MEDICATION_PROVIDERS: Record<string, MedicationProvider> = {
  manual_entry: {
    key: 'manual_entry',
    displayName: 'Manual entry by a data steward',
    licenseBasis: 'operator_owned',
    redistributionAllowed: true,
    jurisdictions: [],
    notes:
      'Entered by hand from a label, a public register or a manufacturer document. ' +
      'The steward is accountable for the value and records source_ref.',
  },
  eda_public_register: {
    key: 'eda_public_register',
    displayName: 'Egyptian Drug Authority public register',
    licenseBasis: 'public_register',
    redistributionAllowed: false,
    jurisdictions: ['EG'],
    notes:
      'Publicly published registration data. Terms of use must be confirmed by the ' +
      'operator for the jurisdiction before an automated import is enabled.',
  },
  rxnorm: {
    key: 'rxnorm',
    displayName: 'RxNorm (US National Library of Medicine)',
    licenseBasis: 'public_domain_us_government',
    redistributionAllowed: true,
    jurisdictions: ['US'],
    notes: 'US federal government work; a UMLS licence may be required for some subsets.',
  },
  openfda: {
    key: 'openfda',
    displayName: 'openFDA / DailyMed',
    licenseBasis: 'public_domain_us_government',
    redistributionAllowed: true,
    jurisdictions: ['US'],
    notes: 'Public US labelling data.',
  },
};

export function getProvider(key: string): MedicationProvider | null {
  return MEDICATION_PROVIDERS[key] ?? null;
}

export function listProviders(): MedicationProvider[] {
  return Object.values(MEDICATION_PROVIDERS);
}
