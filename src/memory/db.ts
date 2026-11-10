// Conversation memory: one row per completed exchange, with the time it was asked and the sources
// the answer used. SQLite through node:sqlite, which is built into Node, so `npm install` never
// has to compile a native module. FTS5 (full-text search) ranks past turns by topic.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Source = { n: number; title: string; url: string; published: string | null; snippet: string };
export type Turn = {
  id: number;
  sessionId: string;
  askedAt: number; // epoch ms
  question: string;
  answer: string;
  sources: Source[];
  model: string;
  origin: "chat" | "seed"; // seed = written by `npm run seed`, labelled as such in the UI
};
export type Memory = ReturnType<typeof openMemory>;

type Row = { id: number; session_id: string; asked_at: number; question: string; answer: string; sources: string; model: string; origin: Turn["origin"] };
const toTurn = (r: Row): Turn => ({ id: r.id, sessionId: r.session_id, askedAt: r.asked_at, question: r.question, answer: r.answer, sources: JSON.parse(r.sources), model: r.model, origin: r.origin });

export function openMemory(file = process.env.MEMORY_FILE || "data/memory.db") {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS turns (
      id         INTEGER PRIMARY KEY,
      session_id TEXT    NOT NULL,
      asked_at   INTEGER NOT NULL,
      question   TEXT    NOT NULL,
      answer     TEXT    NOT NULL,
      sources    TEXT    NOT NULL DEFAULT '[]',
      model      TEXT    NOT NULL DEFAULT '',
      origin     TEXT    NOT NULL DEFAULT 'chat'
    );
    CREATE INDEX IF NOT EXISTS turns_by_time ON turns (asked_at);
    -- porter stemming, so "pricing" also finds "price" and "prices"
    CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5 (question, answer, tokenize = 'porter unicode61');
  `);

  // Ids to leave out (the turns already in the model's context) go in as one JSON array.
  const NOT_IN = "id NOT IN (SELECT value FROM json_each(?))";
  const q = {
    insert: db.prepare("INSERT INTO turns (session_id, asked_at, question, answer, sources, model, origin) VALUES (?, ?, ?, ?, ?, ?, ?)"),
    insertFts: db.prepare("INSERT INTO turns_fts (rowid, question, answer) VALUES (?, ?, ?)"),
    between: db.prepare(`SELECT * FROM turns WHERE asked_at >= ? AND asked_at < ? AND ${NOT_IN} ORDER BY asked_at`),
    session: db.prepare("SELECT * FROM (SELECT * FROM turns WHERE session_id = ? ORDER BY asked_at DESC LIMIT ?) ORDER BY asked_at"),
    recent: db.prepare(`SELECT * FROM turns WHERE ${NOT_IN} ORDER BY asked_at DESC LIMIT ?`),
    byIds: db.prepare("SELECT * FROM turns WHERE id IN (SELECT value FROM json_each(?))"),
    topic: db.prepare("SELECT rowid AS id, bm25(turns_fts) AS rank FROM turns_fts WHERE turns_fts MATCH ? ORDER BY rank LIMIT ?"),
    stats: db.prepare("SELECT COUNT(*) AS n, MIN(asked_at) AS first FROM turns"),
    list: db.prepare("SELECT id, session_id, asked_at, question, origin FROM turns ORDER BY asked_at DESC LIMIT ?"),
  };

  return {
    /** Store one completed exchange; returns its id. */
    add(t: Omit<Turn, "id">): number {
      db.exec("BEGIN");
      try {
        const id = Number(q.insert.run(t.sessionId, t.askedAt, t.question, t.answer, JSON.stringify(t.sources), t.model, t.origin).lastInsertRowid);
        q.insertFts.run(id, t.question, t.answer);
        db.exec("COMMIT");
        return id;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    /** Turns asked in [start, end), oldest first. */
    between: (start: number, end: number, exclude: number[] = []) => (q.between.all(start, end, JSON.stringify(exclude)) as Row[]).map(toTurn),
    /** The last `limit` turns of one conversation, oldest first. */
    session: (sessionId: string, limit = 50) => (q.session.all(sessionId, limit) as Row[]).map(toTurn),
    /** Newest first. */
    recent: (limit: number, exclude: number[] = []) => (q.recent.all(JSON.stringify(exclude), limit) as Row[]).map(toTurn),
    byIds: (ids: number[]) => (q.byIds.all(JSON.stringify(ids)) as Row[]).map(toTurn),
    /** Topic relevance by id for an FTS5 query; higher is more relevant. Empty for an empty query. */
    topic(match: string, limit = 50): Map<number, number> {
      if (!match) return new Map();
      return new Map((q.topic.all(match, limit) as { id: number; rank: number }[]).map((r) => [r.id, -r.rank]));
    },
    stats: () => q.stats.get() as { n: number; first: number | null },
    /** Newest first, for the history list in the UI. */
    list: (limit = 500) => q.list.all(limit) as { id: number; session_id: string; asked_at: number; question: string; origin: Turn["origin"] }[],
  };
}
