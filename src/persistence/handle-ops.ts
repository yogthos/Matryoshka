/**
 * HandleOps - Operations on handles (server-side execution)
 *
 * All operations work on handles and return new handles,
 * avoiding the need to transfer full datasets to the LLM.
 */

import type { SessionDB } from "./session-db.js";
import type { HandleRegistry } from "./handle-registry.js";
import { PredicateCompiler } from "./predicate-compiler.js";

export interface DescribeResult {
  count: number;
  fields: string[];
  sample: unknown[];
}

export class HandleOps {
  private db: SessionDB;
  private registry: HandleRegistry;
  private compiler: PredicateCompiler;

  constructor(db: SessionDB, registry: HandleRegistry) {
    this.db = db;
    this.registry = registry;
    this.compiler = new PredicateCompiler();
  }

  /**
   * Count items in a handle
   */
  count(handle: string): number {
    const data = this.registry.get(handle);
    if (data === null) {
      throw new Error(`Invalid handle: ${handle}`);
    }
    return data.length;
  }

  /**
   * Sum a numeric field across all items
   */
  sum(handle: string, field: string): number {
    const data = this.registry.get(handle);
    if (data === null) {
      throw new Error(`Invalid handle: ${handle}`);
    }

    return data.reduce((acc: number, item) => {
      if (typeof item === "object" && item !== null && field in item) {
        const value = (item as Record<string, unknown>)[field];
        if (typeof value === "number") {
          return acc + value;
        }
      }
      return acc;
    }, 0);
  }

  /**
   * Sum by extracting numbers from the line field
   */
  sumFromLine(handle: string): number {
    const data = this.registry.get(handle);
    if (data === null) {
      throw new Error(`Invalid handle: ${handle}`);
    }

    return data.reduce((acc: number, item) => {
      if (typeof item === "object" && item !== null && "line" in item) {
        const line = String((item as { line: string }).line);
        // Extract number from line (handles $1,000 format)
        const match = line.match(/\$?([\d,]+(?:\.\d+)?)/);
        if (match) {
          const num = parseFloat(match[1].replace(/,/g, ""));
          if (!isNaN(num)) {
            return acc + num;
          }
        }
      }
      return acc;
    }, 0);
  }

  /**
   * Filter items by predicate, return new handle
   */
  filter(handle: string, predicate: string): string {
    const data = this.registry.get(handle);
    if (data === null) {
      throw new Error(`Invalid handle: ${handle}`);
    }

    const predicateFn = this.compiler.compile(predicate);
    const filtered = data.filter((item) => predicateFn(item));
    return this.registry.store(filtered);
  }

  /**
   * Transform items, return new handle
   */
  map(handle: string, expression: string): string {
    const data = this.registry.get(handle);
    if (data === null) {
      throw new Error(`Invalid handle: ${handle}`);
    }

    const transformFn = this.compiler.compileTransform(expression);
    const mapped = data.map((item) => transformFn(item));
    return this.registry.store(mapped);
  }

  /**
   * Sort items by field, return new handle
   */
  sort(handle: string, field: string, direction: "asc" | "desc" = "asc"): string {
    const data = this.registry.get(handle);
    if (data === null) {
      throw new Error(`Invalid handle: ${handle}`);
    }

    const sorted = [...data].sort((a, b) => {
      const aVal = typeof a === "object" && a !== null ? (a as Record<string, unknown>)[field] : a;
      const bVal = typeof b === "object" && b !== null ? (b as Record<string, unknown>)[field] : b;

      let cmp = 0;
      if (typeof aVal === "number" && typeof bVal === "number") {
        cmp = aVal - bVal;
      } else {
        cmp = String(aVal).localeCompare(String(bVal));
      }

      return direction === "desc" ? -cmp : cmp;
    });

    return this.registry.store(sorted);
  }

  /**
   * Get first N items (for limited inspection)
   */
  preview(handle: string, n: number): unknown[] {
    const data = this.registry.get(handle);
    if (data === null) {
      throw new Error(`Invalid handle: ${handle}`);
    }
    return data.slice(0, n);
  }

  /**
   * Get random N items
   */
  sample(handle: string, n: number): unknown[] {
    const data = this.registry.get(handle);
    if (data === null) {
      throw new Error(`Invalid handle: ${handle}`);
    }

    if (data.length <= n) {
      return [...data];
    }

    // Fisher-Yates shuffle for random sample
    const shuffled = [...data];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    return shuffled.slice(0, n);
  }

  /**
   * Describe handle contents (schema + stats)
   */
  describe(handle: string): DescribeResult {
    const data = this.registry.get(handle);
    if (data === null) {
      throw new Error(`Invalid handle: ${handle}`);
    }

    // Collect field names from objects
    const fields = new Set<string>();
    for (const item of data) {
      if (typeof item === "object" && item !== null) {
        for (const key of Object.keys(item)) {
          fields.add(key);
        }
      }
    }

    return {
      count: data.length,
      fields: Array.from(fields),
      sample: data.slice(0, 3),
    };
  }
}
