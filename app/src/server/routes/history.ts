import type { FastifyInstance } from 'fastify';
import { exportCsv, searchHistory, type HistoryQuery } from '../history/history.js';

function parseQuery(raw: Record<string, string | undefined>): HistoryQuery {
  return {
    text: raw.text || undefined,
    folderId: raw.folderId ? Number(raw.folderId) : undefined,
    status: raw.status || undefined,
    page: raw.page ? Number(raw.page) : undefined,
    pageSize: raw.pageSize ? Number(raw.pageSize) : undefined,
  };
}

export function registerHistoryRoutes(app: FastifyInstance): void {
  const { db } = app.deps;

  app.get('/api/history', async (req) => {
    const q = parseQuery(req.query as Record<string, string>);
    return { rows: searchHistory(db, q), page: q.page ?? 1, pageSize: q.pageSize ?? 50 };
  });

  // Exports every matching row (not just a page). BOM so Excel reads the UTF-8 correctly.
  app.get('/api/history.csv', async (req, reply) => {
    const q = { ...parseQuery(req.query as Record<string, string>), page: 1, pageSize: 1_000_000 };
    const day = new Date().toISOString().slice(0, 10);
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="localtube-history-${day}.csv"`)
      .send('﻿' + exportCsv(searchHistory(db, q)));
  });
}
