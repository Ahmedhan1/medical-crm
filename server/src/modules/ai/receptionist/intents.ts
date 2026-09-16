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
const CLINICAL_PATTERNS: RegExp[] = [
  /\b(symptom|symptoms|pain|ache|aching|fever|cough|bleed|bleeding|rash|swelling|nausea|vomit|dizz|short(ness)? of breath|chest pain)\b/i,
  /\b(diagnos|prognos|treat(ment)?|therapy|cure)\b/i,
  /\b(prescri|medication|medicine|dose|dosage|drug|pill|tablet|antibiotic|insulin)\b/i,
  /\b(should i (take|stop|continue)|is it safe to|side effect|allerg(y|ic))\b/i,
  /\b(pregnan|infection|infected|blood pressure|sugar level|test results?|lab results?)\b/i,
  /\b(feel(ing)? (sick|unwell|ill)|emergency|urgent care|worse|getting worse)\b/i,
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
