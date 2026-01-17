/**
 * SessionDB - In-memory SQLite database for session state
 *
 * Provides:
 * - FTS5 full-text search for document lines
 * - Handle storage for result sets
 * - Checkpoint persistence for session resume
 */

import Database from "better-sqlite3";

export interface DocumentLine {
  lineNum: number;
  content: string;
}

export interface HandleMetadata {
  handle: string;
  type: string;
  count: number;
  createdAt: number;
}

export class SessionDB {
  private db: Database.Database | null;
  private handleCounter: number = 0;

  constructor() {
    // Create in-memory database
    this.db = new Database(":memory:");
    this.initSchema();
  }

  private initSchema(): void {
    if (!this.db) return;

    // Document lines table with FTS5
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS document_lines (
        lineNum INTEGER PRIMARY KEY,
        content TEXT NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS document_lines_fts USING fts5(
        content,
        content='document_lines',
        content_rowid='lineNum'
      );

      -- Triggers to keep FTS in sync
      CREATE TRIGGER IF NOT EXISTS document_lines_ai AFTER INSERT ON document_lines BEGIN
        INSERT INTO document_lines_fts(rowid, content) VALUES (new.lineNum, new.content);
      END;

      CREATE TRIGGER IF NOT EXISTS document_lines_ad AFTER DELETE ON document_lines BEGIN
        INSERT INTO document_lines_fts(document_lines_fts, rowid, content) VALUES('delete', old.lineNum, old.content);
      END;

      CREATE TRIGGER IF NOT EXISTS document_lines_au AFTER UPDATE ON document_lines BEGIN
        INSERT INTO document_lines_fts(document_lines_fts, rowid, content) VALUES('delete', old.lineNum, old.content);
        INSERT INTO document_lines_fts(rowid, content) VALUES (new.lineNum, new.content);
      END;

      -- Handles registry
      CREATE TABLE IF NOT EXISTS handles (
        handle TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        count INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );

      -- Handle data storage (JSON)
      CREATE TABLE IF NOT EXISTS handle_data (
        handle TEXT NOT NULL,
        idx INTEGER NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (handle, idx),
        FOREIGN KEY (handle) REFERENCES handles(handle) ON DELETE CASCADE
      );

      -- Checkpoints
      CREATE TABLE IF NOT EXISTS checkpoints (
        turn INTEGER PRIMARY KEY,
        bindings TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      );
    `);
  }

  /**
   * Check if database is open
   */
  isOpen(): boolean {
    return this.db !== null;
  }

  /**
   * Get list of tables in database
   */
  getTables(): string[] {
    if (!this.db) return [];
    const stmt = this.db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type='table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `);
    const rows = stmt.all() as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }

  /**
   * Check if FTS5 virtual table exists
   */
  hasFTS5(): boolean {
    if (!this.db) return false;
    const stmt = this.db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type='table' AND name='document_lines_fts'
    `);
    const row = stmt.get();
    return row !== undefined;
  }

  /**
   * Load document content into the database
   */
  loadDocument(content: string): number {
    if (!this.db) return 0;

    // Clear existing data
    this.db.exec("DELETE FROM document_lines");

    // Handle empty document
    if (!content) {
      return 0;
    }

    const lines = content.split("\n");
    const insert = this.db.prepare(
      "INSERT INTO document_lines (lineNum, content) VALUES (?, ?)"
    );

    const insertMany = this.db.transaction((lines: string[]) => {
      for (let i = 0; i < lines.length; i++) {
        insert.run(i + 1, lines[i]);
      }
    });

    insertMany(lines);
    return lines.length;
  }

  /**
   * Get lines in range (1-indexed)
   */
  getLines(start: number, end: number): DocumentLine[] {
    if (!this.db) return [];
    const stmt = this.db.prepare(`
      SELECT lineNum, content FROM document_lines
      WHERE lineNum >= ? AND lineNum <= ?
      ORDER BY lineNum
    `);
    return stmt.all(start, end) as DocumentLine[];
  }

  /**
   * Get total line count
   */
  getLineCount(): number {
    if (!this.db) return 0;
    const stmt = this.db.prepare("SELECT COUNT(*) as count FROM document_lines");
    const row = stmt.get() as { count: number };
    return row.count;
  }

  /**
   * Search document using FTS5
   */
  search(query: string): DocumentLine[] {
    if (!this.db) return [];

    // Use FTS5 MATCH query
    const stmt = this.db.prepare(`
      SELECT d.lineNum, d.content
      FROM document_lines d
      JOIN document_lines_fts f ON d.lineNum = f.rowid
      WHERE document_lines_fts MATCH ?
      ORDER BY d.lineNum
    `);

    try {
      return stmt.all(query) as DocumentLine[];
    } catch {
      // If FTS5 query fails, fall back to empty
      return [];
    }
  }

  /**
   * Create a handle for storing data array
   */
  createHandle(data: unknown[]): string {
    if (!this.db) throw new Error("Database not open");

    this.handleCounter++;
    const handle = `$res${this.handleCounter}`;
    const now = Date.now();

    // Insert handle metadata
    const insertHandle = this.db.prepare(`
      INSERT INTO handles (handle, type, count, created_at)
      VALUES (?, ?, ?, ?)
    `);
    insertHandle.run(handle, "array", data.length, now);

    // Insert data rows
    const insertData = this.db.prepare(`
      INSERT INTO handle_data (handle, idx, data) VALUES (?, ?, ?)
    `);

    const insertAll = this.db.transaction((items: unknown[]) => {
      for (let i = 0; i < items.length; i++) {
        insertData.run(handle, i, JSON.stringify(items[i]));
      }
    });

    insertAll(data);
    return handle;
  }

  /**
   * Get handle metadata
   */
  getHandleMetadata(handle: string): HandleMetadata | null {
    if (!this.db) return null;
    const stmt = this.db.prepare(`
      SELECT handle, type, count, created_at as createdAt
      FROM handles WHERE handle = ?
    `);
    const row = stmt.get(handle) as HandleMetadata | undefined;
    return row ?? null;
  }

  /**
   * Get data stored in a handle
   */
  getHandleData(handle: string): unknown[] {
    if (!this.db) return [];
    const stmt = this.db.prepare(`
      SELECT data FROM handle_data
      WHERE handle = ?
      ORDER BY idx
    `);
    const rows = stmt.all(handle) as Array<{ data: string }>;
    return rows.map((r) => JSON.parse(r.data));
  }

  /**
   * Delete a handle and its data
   */
  deleteHandle(handle: string): void {
    if (!this.db) return;
    // Data will be cascade-deleted due to foreign key
    const stmt = this.db.prepare("DELETE FROM handles WHERE handle = ?");
    stmt.run(handle);
  }

  /**
   * Save a checkpoint
   */
  saveCheckpoint(turn: number, bindings: Map<string, string>): void {
    if (!this.db) return;
    const bindingsJson = JSON.stringify(Object.fromEntries(bindings));
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO checkpoints (turn, bindings, timestamp)
      VALUES (?, ?, ?)
    `);
    stmt.run(turn, bindingsJson, Date.now());
  }

  /**
   * Get a checkpoint
   */
  getCheckpoint(turn: number): Map<string, string> | null {
    if (!this.db) return null;
    const stmt = this.db.prepare("SELECT bindings FROM checkpoints WHERE turn = ?");
    const row = stmt.get(turn) as { bindings: string } | undefined;
    if (!row) return null;
    const obj = JSON.parse(row.bindings) as Record<string, string>;
    return new Map(Object.entries(obj));
  }

  /**
   * Get all checkpoint turns
   */
  getCheckpointTurns(): number[] {
    if (!this.db) return [];
    const stmt = this.db.prepare("SELECT turn FROM checkpoints ORDER BY turn");
    const rows = stmt.all() as Array<{ turn: number }>;
    return rows.map((r) => r.turn);
  }

  /**
   * Delete a specific checkpoint
   */
  deleteCheckpoint(turn: number): void {
    if (!this.db) return;
    const stmt = this.db.prepare("DELETE FROM checkpoints WHERE turn = ?");
    stmt.run(turn);
  }

  /**
   * Clear all checkpoints
   */
  clearCheckpoints(): void {
    if (!this.db) return;
    this.db.exec("DELETE FROM checkpoints");
  }

  /**
   * Clear all data (but keep schema)
   */
  clearAll(): void {
    if (!this.db) return;
    this.db.exec(`
      DELETE FROM document_lines;
      DELETE FROM handles;
      DELETE FROM checkpoints;
    `);
    this.handleCounter = 0;
  }

  /**
   * Close the database connection
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
