import { getPool } from '../../../db/pool.js';
import { ValidationError } from '../../../domain/errors.js';
import { requirePermission, type Principal } from '../../governance/rbac.js';
import { Permission } from '../../governance/permissions.js';
import { authorizeAiRequest } from '../gateway.js';
import { recordGenerationPool } from '../observability.js';
import { classifyReceptionistIntent, type ReceptionistCategory, type ReceptionistIntent } from './intents.js';

/**
 * AI Receptionist Foundation (E5).
 *
 * An ADMINISTRATIVE assistant only. It classifies a message, proposes a safe
 * non-clinical reply, and routes/escalates — it NEVER books, sends, schedules or
 * mutates anything (all outputs are proposals for a human/routing layer), and it
 * NEVER answers a clinical question: any clinical signal is escalated to human
 * clinical staff. Governed by the E3 AI gateway (classification + tenant policy)
 * like every other AI capability. The message text is never stored.
 */
export interface ReceptionistRequest {
  text: string;
}

export interface ReceptionistResponse {
  requestId: string;
  intent: ReceptionistIntent;
  category: ReceptionistCategory;
  escalate: boolean;
  escalateTo: 'clinical_staff' | 'reception_staff' | null;
  action: 'answer' | 'route_to_staff' | 'escalate_clinical';
  /** A safe, non-clinical, non-committal proposed reply. */
  reply: string;
  /** Always false — the receptionist proposes; it never acts. */
  mutating: false;
}

const CLINICAL_DEFLECTION =
  'I can help with administrative questions such as appointments, clinic hours, ' +
  'location and required documents. For any medical concern I will connect you ' +
  'with our clinical team, who are best placed to help.';

function adminReply(intent: ReceptionistIntent, clinicName: string | null): { reply: string; action: ReceptionistResponse['action'] } {
  const where = clinicName ? ` at ${clinicName}` : '';
  switch (intent) {
    case 'clinic_hours':
      return { reply: `I can help with clinic hours${where}. Let me route you to our reception team for the exact schedule.`, action: 'route_to_staff' };
    case 'location':
      return { reply: `I can share clinic location and directions${where}. Connecting you with reception for the precise details.`, action: 'route_to_staff' };
    case 'doctor_availability':
      return { reply: 'Doctor availability changes daily — our reception team can confirm the current schedule for you.', action: 'route_to_staff' };
    case 'book_appointment':
      return { reply: 'I can help start an appointment booking. Reception will confirm an available slot (I do not book on your behalf).', action: 'route_to_staff' };
    case 'reschedule_appointment':
      return { reply: 'I can help you request a reschedule. Reception will confirm the new time.', action: 'route_to_staff' };
    case 'cancel_appointment':
      return { reply: 'I can pass a cancellation request to reception, who will confirm it with you.', action: 'route_to_staff' };
    case 'preparation_instructions':
      return { reply: 'General preparation guidance is available; for anything specific to your visit, reception will confirm the details.', action: 'route_to_staff' };
    case 'document_requirements':
      return { reply: 'Typically bring a photo ID and any insurance or referral documents. Reception can confirm exactly what your visit needs.', action: 'answer' };
    case 'package_info':
      return { reply: 'I can route package and pricing questions to reception, who handle billing details.', action: 'route_to_staff' };
    default:
      return { reply: 'I can help with administrative questions. Let me route you to our reception team.', action: 'route_to_staff' };
  }
}

export async function handleReceptionistMessage(
  principal: Principal,
  input: ReceptionistRequest,
): Promise<ReceptionistResponse> {
  requirePermission(principal, Permission.AI_RECEPTIONIST_USE);
  const text = input.text ?? '';
  if (!text.trim()) throw new ValidationError('Receptionist message is required');

  // Governed by the E3 gateway (classify → tenant policy → provider routing),
  // even though classification is deterministic — keeps AI on one governed path.
  const auth = await authorizeAiRequest({
    clinicId: principal.clinicId,
    capability: 'receptionist',
    actorId: principal.userId,
  });

  const { intent, category } = classifyReceptionistIntent(text);

  let response: ReceptionistResponse;
  if (category === 'clinical') {
    response = {
      requestId: auth.requestId,
      intent,
      category,
      escalate: true,
      escalateTo: 'clinical_staff',
      action: 'escalate_clinical',
      reply: CLINICAL_DEFLECTION,
      mutating: false,
    };
  } else if (category === 'administrative') {
    const clinic = await getPool().query<{ name: string }>(`SELECT name FROM clinic WHERE id = $1`, [principal.clinicId]);
    const { reply, action } = adminReply(intent, clinic.rows[0]?.name ?? null);
    response = {
      requestId: auth.requestId,
      intent,
      category,
      escalate: action === 'route_to_staff',
      escalateTo: action === 'route_to_staff' ? 'reception_staff' : null,
      action,
      reply,
      mutating: false,
    };
  } else {
    response = {
      requestId: auth.requestId,
      intent,
      category,
      escalate: true,
      escalateTo: 'reception_staff',
      action: 'route_to_staff',
      reply: 'I can help with administrative questions. Let me route you to our reception team.',
      mutating: false,
    };
  }

  // Observability: labels/sizes only — never the message text.
  await recordGenerationPool({
    clinicId: principal.clinicId,
    kind: 'receptionist',
    provider: auth.provider.id,
    model: auth.provider.model,
    status: 'succeeded',
    inputChars: text.length,
    outputChars: response.reply.length,
    dataClass: auth.classification,
    policyDecision: auth.decision,
    providerTier: auth.providerTier,
    requestId: auth.requestId,
  });

  return response;
}
