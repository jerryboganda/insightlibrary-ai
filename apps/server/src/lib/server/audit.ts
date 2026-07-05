/**
 * Fire-and-forget audit persistence. Writes an audit_logs row without ever
 * blocking or failing the request that triggered it — insert errors are logged
 * and swallowed. No-ops in memory mode (no DATABASE_URL → getDb() is null).
 */
import { getDb } from './db/client';
import { auditLogs } from './db/schema';

export type AuditSeverity = 'info' | 'warning' | 'critical';

export interface AuditEvent {
	/** Falls back to the seeded org when absent/empty (column is NOT NULL + FK). */
	orgId?: string | null;
	actor: string;
	action: string;
	target: string;
	severity?: AuditSeverity;
}

let seq = 0;

/** Persist an audit event asynchronously. Never throws, never blocks. */
export function recordAudit(event: AuditEvent): void {
	const db = getDb();
	if (!db) return;
	seq = (seq + 1) % 1_000_000;
	const id = `al_${Date.now().toString(36)}_${seq.toString(36)}`;
	void db
		.insert(auditLogs)
		.values({
			id,
			orgId: event.orgId || 'org_1',
			actor: event.actor,
			action: event.action,
			target: event.target,
			severity: event.severity ?? 'info'
		})
		.catch((e) => {
			console.error('[audit] failed to persist audit event:', e instanceof Error ? e.message : e);
		});
}
