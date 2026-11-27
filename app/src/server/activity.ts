import type { Db } from './db/db.js';

export function logActivity(db: Db, entityType: string, entityId: number | null, eventType: string, message: string, details?: unknown): void {
  db.prepare('INSERT INTO activity_log(entity_type, entity_id, event_type, message, details_json) VALUES(?,?,?,?,?)').run(
    entityType,
    entityId,
    eventType,
    message,
    details === undefined ? null : JSON.stringify(details),
  );
}
