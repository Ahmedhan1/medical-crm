/**
 * AI Receptionist — deterministic administrative intent classification (E5).
 *
 * Rule-based and deterministic (no model call): maps a message to an
 * administrative intent, OR flags it as a clinical question that MUST be
 * escalated to a human. The safety-critical rule is CLINICAL-FIRST: if the
 * message contains any clinical signal it is classified `clinical` and escalated
 * regardless of any administrative keywords, so the receptionist never answers a
 * medical question.
 */
export type ReceptionistCategory = 'administrative' | 'clinical' | 'other';

export type ReceptionistIntent =
  | 'clinic_hours'
  | 'location'
  | 'doctor_availability'
  | 'book_appointment'
  | 'reschedule_appointment'
  | 'cancel_appointment'
  | 'preparation_instructions'
  | 'document_requirements'
  | 'package_info'
  | 'admin_faq'
  | 'clinical_question'
  | 'other';

export interface IntentClassification {
  intent: ReceptionistIntent;
  category: ReceptionistCategory;
}

/**
 * Clinical signals. If ANY match, the message is treated as a clinical question
 * and escalated — this list is intentionally broad and checked FIRST.
 */
// Each clinical stem is matched as a WORD PREFIX (leading \b, NO trailing \b):
// a trailing \b would (wrongly) require the stem to be a whole word, so
// `diagnos\b` never matches "diagnose"/"diagnosis" and `prescri\b` never matches
// "prescribe"/"prescription" — a dangerous under-escalation. Prefix matching also
// covers inflections (vomit→vomiting, dizz→dizzy, treat→treatment, infect→infected).
// Over-matching only ever OVER-escalates to a human, which is the fail-safe side.
const CLINICAL_PATTERNS: RegExp[] = [
  /\b(symptom|pain|ache|aching|fever|cough|bleed|rash|swelling|nausea|vomit|dizz|short(ness)? of breath|chest pain)/i,
  /\b(diagnos|prognos|treat|therap|cure)/i,
  /\b(prescri|medication|medicine|dose|dosage|drug|pill|tablet|antibiotic|insulin)/i,
  /\b(should i (take|stop|continue)|is it safe to|side effect|allerg(y|ic|ies))/i,
  /\b(pregnan|infection|infected|blood pressure|sugar level|test results?|lab results?)/i,
  /\b(feel(ing)? (sick|unwell|ill)|emergency|urgent care|worse|getting worse)/i,
];

interface AdminRule {
  intent: ReceptionistIntent;
  patterns: RegExp[];
}

const ADMIN_RULES: AdminRule[] = [
  { intent: 'clinic_hours', patterns: [/\b(open|opening|close|closing|hours|timing|what time)\b/i] },
  { intent: 'location', patterns: [/\b(where|located|location|address|direction|parking|map)\b/i] },
  { intent: 'doctor_availability', patterns: [/\b(which doctor|doctor available|is (dr|doctor)\.?\s|availability of (the )?doctor)\b/i] },
  { intent: 'book_appointment', patterns: [/\b(book|schedule|make) (an )?appointment\b/i, /\bnew appointment\b/i] },
  { intent: 'reschedule_appointment', patterns: [/\b(reschedul|move|change) (my )?appointment\b/i] },
  { intent: 'cancel_appointment', patterns: [/\bcancel (my )?appointment\b/i] },
  { intent: 'preparation_instructions', patterns: [/\b(prepare|preparation|fasting|before (my|the) (visit|appointment)|bring)\b/i] },
  { intent: 'document_requirements', patterns: [/\b(document|documents|paperwork|id card|insurance card|referral letter|what.*(bring|need))\b/i] },
  { intent: 'package_info', patterns: [/\b(package|packages|bundle|offer|price|pricing|cost|fee|payment)\b/i] },
];

/**
 * Classify a receptionist message. Clinical signals win over everything.
 * The raw text is never returned or stored — only the derived labels.
 */
export function classifyReceptionistIntent(text: string): IntentClassification {
  const t = (text ?? '').trim();
  if (!t) return { intent: 'other', category: 'other' };

  // Clinical-first: any clinical signal → escalate.
  if (CLINICAL_PATTERNS.some((re) => re.test(t))) {
    return { intent: 'clinical_question', category: 'clinical' };
  }

  for (const rule of ADMIN_RULES) {
    if (rule.patterns.some((re) => re.test(t))) {
      return { intent: rule.intent, category: 'administrative' };
    }
  }

  // Recognisably a question but not matched → generic admin FAQ (still non-clinical).
  if (/\?|\b(can|could|do|does|is|are|when|how|what|where)\b/i.test(t)) {
    return { intent: 'admin_faq', category: 'administrative' };
  }
  return { intent: 'other', category: 'other' };
}
