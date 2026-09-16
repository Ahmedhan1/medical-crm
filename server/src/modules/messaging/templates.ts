import { getPool, withTransaction, type PoolClient } from '../../db/pool.js';
import { ValidationError } from '../../domain/errors.js';
import { auditTx } from '../governance/audit.js';
import { requirePermission, type Principal } from '../governance/rbac.js';
import { Permission } from '../governance/permissions.js';
import type { Channel } from './messaging.types.js';

/**
 * Message template rendering.
 *
 * Templates hold approved copy with `{{variable}}` placeholders. Rendering
 * substitutes ONLY the variables supplied; an unknown placeholder is a hard
 * error (a template must never silently emit a literal `{{name}}` to a patient),
 * and a variable that is supplied but not referenced is ignored. This bounds
 * exactly what content — and therefore what PHI — a message can contain.
 */
const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

export interface MessageTemplate {
  id: string;
  clinicId: string;
  key: string;
  channel: Channel;
  locale: string;
  body: string;
  isActive: boolean;
}

interface TemplateRow {
  id: string;
  clinic_id: string;
  key: string;
  channel: Channel;
  locale: string;
  body: string;
  is_active: boolean;
}

function mapTemplate(r: TemplateRow): MessageTemplate {
  return {
    id: r.id,
    clinicId: r.clinic_id,
    key: r.key,
    channel: r.channel,
    locale: r.locale,
    body: r.body,
    isActive: r.is_active,
  };
}

/** Variable names referenced by a template body. */
export function templateVariables(body: string): string[] {
  const names = new Set<string>();
  for (const match of body.matchAll(PLACEHOLDER)) names.add(match[1]!);
  return [...names];
}

/**
 * Render a template body against a variable map. Throws if a referenced
 * variable is missing so a half-rendered message is never sent.
 */
export function renderTemplate(body: string, variables: Record<string, string>): string {
  const missing: string[] = [];
  const rendered = body.replace(PLACEHOLDER, (_full, name: string) => {
    if (!(name in variables)) {
      missing.push(name);
      return '';
    }
    return variables[name]!;
  });
  if (missing.length > 0) {
    throw new ValidationError('Template is missing required variables', { missing });
  }
  return rendered;
}

export async function getActiveTemplate(
  clinicId: string,
  key: string,
  channel: Channel,
  locale = 'en',
): Promise<MessageTemplate | null> {
  const { rows } = await getPool().query<TemplateRow>(
    `SELECT * FROM message_template
      WHERE clinic_id = $1 AND key = $2 AND channel = $3 AND locale = $4 AND is_active = true`,
    [clinicId, key, channel, locale],
  );
  return rows[0] ? mapTemplate(rows[0]) : null;
}

export interface UpsertTemplateInput {
  clinicId: string;
  key: string;
  channel: Channel;
  locale?: string;
  body: string;
  createdBy: string;
}

export async function upsertTemplate(
  client: PoolClient,
  input: UpsertTemplateInput,
): Promise<MessageTemplate> {
  const { rows } = await client.query<TemplateRow>(
    `INSERT INTO message_template (clinic_id, key, channel, locale, body, created_by)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (clinic_id, key, channel, locale)
       DO UPDATE SET body = EXCLUDED.body, is_active = true, updated_at = now()
     RETURNING *`,
    [input.clinicId, input.key, input.channel, input.locale ?? 'en', input.body, input.createdBy],
  );
  return mapTemplate(rows[0]!);
}

export async function listTemplates(clinicId: string): Promise<MessageTemplate[]> {
  const { rows } = await getPool().query<TemplateRow>(
    `SELECT * FROM message_template WHERE clinic_id = $1 ORDER BY key, channel, locale`,
    [clinicId],
  );
  return rows.map(mapTemplate);
}

// --- Authorized service wrappers -------------------------------------------

/** Create/update an approved template. Requires MESSAGING_MANAGE; audited. */
export async function saveTemplate(
  principal: Principal,
  input: { key: string; channel: Channel; locale?: string; body: string },
): Promise<MessageTemplate> {
  requirePermission(principal, Permission.MESSAGING_MANAGE);
  // Validate the body has no malformed placeholders by parsing its variables.
  templateVariables(input.body);
  return withTransaction(async (client) => {
    const template = await upsertTemplate(client, {
      clinicId: principal.clinicId,
      key: input.key,
      channel: input.channel,
      locale: input.locale,
      body: input.body,
      createdBy: principal.userId,
    });
    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'message.template.save',
      outcome: 'success',
      targetType: 'message_template',
      targetId: template.id,
      metadata: { key: template.key, channel: template.channel, locale: template.locale },
    });
    return template;
  });
}

export async function getTemplatesForClinic(principal: Principal): Promise<MessageTemplate[]> {
  requirePermission(principal, Permission.MESSAGING_READ);
  return listTemplates(principal.clinicId);
}
