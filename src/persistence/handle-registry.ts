/**
 * HandleRegistry - Manages handles for result data
 *
 * Handles are opaque references to data stored in SQLite.
 * The LLM sees only metadata stubs, not the full data, achieving 97%+ token savings.
 */

import type { SessionDB } from "./session-db.js";

export interface HandleStub {
  handle: string;
  type: string;
  count: number;
  preview: string;
}

export class HandleRegistry {
  private db: SessionDB;
  private resultsHandle: string | null = null;

  constructor(db: SessionDB) {
    this.db = db;
  }

  /**
   * Store an array of data and return a handle reference
   */
  store(data: unknown[]): string {
    return this.db.createHandle(data);
  }

  /**
   * Get full data from a handle
   */
  get(handle: string): unknown[] | null {
    const meta = this.db.getHandleMetadata(handle);
    if (!meta) return null;
    return this.db.getHandleData(handle);
  }

  /**
   * Get a compact stub representation for context building
   */
  getStub(handle: string): string {
    const meta = this.db.getHandleMetadata(handle);
    if (!meta) return `${handle}: <invalid handle>`;

    // Get preview of first few items
    const data = this.db.getHandleData(handle);
    let preview = "";

    if (data.length > 0) {
      const firstItem = data[0];
      if (typeof firstItem === "object" && firstItem !== null) {
        // For objects, show abbreviated first item
        const obj = firstItem as Record<string, unknown>;
        // Check for common line content fields
        const lineContent = obj.line ?? obj.content ?? obj.text;
        if (lineContent !== undefined) {
          const line = String(lineContent);
          preview = line.length > 50 ? line.slice(0, 50) + "..." : line;
        } else {
          const keys = Object.keys(obj).slice(0, 3);
          preview = keys.join(", ");
        }
      } else {
        preview = String(firstItem).slice(0, 50);
      }
    }

    return `${handle}: Array(${meta.count}) [${preview}]`;
  }

  /**
   * Build context string with all handle stubs for LLM
   */
  buildContext(): string {
    const handles = this.listHandles();
    if (handles.length === 0) return "";

    const stubs = handles.map((h) => this.getStub(h));
    return "## Variable Bindings\n" + stubs.join("\n");
  }

  /**
   * Set the current RESULTS handle
   */
  setResults(handle: string): void {
    this.resultsHandle = handle;
  }

  /**
   * Get the current RESULTS handle
   */
  getResults(): string | null {
    return this.resultsHandle;
  }

  /**
   * Resolve RESULTS to actual data
   */
  resolveResults(): unknown[] | null {
    if (!this.resultsHandle) return null;
    return this.get(this.resultsHandle);
  }

  /**
   * Delete a handle
   */
  delete(handle: string): void {
    this.db.deleteHandle(handle);
    if (this.resultsHandle === handle) {
      this.resultsHandle = null;
    }
  }

  /**
   * List all active handles
   */
  listHandles(): string[] {
    // Get handles from database
    // We need to query the handles table
    const handles: string[] = [];
    let counter = 1;
    // Check each potential handle up to a reasonable limit
    while (counter <= 1000) {
      const handle = `$res${counter}`;
      const meta = this.db.getHandleMetadata(handle);
      if (meta) {
        handles.push(handle);
      }
      counter++;
      // Stop early if we've gone 10 handles without finding one
      if (counter > handles.length + 10) break;
    }
    return handles;
  }

  /**
   * Get count of items in a handle
   */
  getCount(handle: string): number {
    const meta = this.db.getHandleMetadata(handle);
    return meta?.count ?? 0;
  }
}
