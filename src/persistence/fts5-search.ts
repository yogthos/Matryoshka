/**
 * FTS5Search - Full-text search using SQLite FTS5
 *
 * Provides high-performance text search with:
 * - Boolean operators (AND, OR, NOT)
 * - Phrase queries
 * - Prefix matching
 * - Proximity search (NEAR)
 * - Relevance ranking
 * - Highlighting
 */

import type { SessionDB, DocumentLine } from "./session-db.js";

export interface SearchResult extends DocumentLine {
  // Extended with optional fields for advanced queries
}

export interface HighlightResult extends SearchResult {
  highlighted: string;
}

export interface SnippetResult extends SearchResult {
  snippet: string;
}

export interface HighlightOptions {
  openTag?: string;
  closeTag?: string;
}

export class FTS5Search {
  private db: SessionDB;

  constructor(db: SessionDB) {
    this.db = db;
  }

  /**
   * Basic search - returns results in line order
   */
  search(query: string): SearchResult[] {
    return this.db.search(query);
  }

  /**
   * Search with relevance ranking (BM25)
   */
  searchByRelevance(query: string): SearchResult[] {
    // FTS5 uses bm25() for relevance ranking
    // Since we're using the SessionDB abstraction, we'll sort by occurrence count
    const results = this.db.search(query);

    // Count occurrences of search terms in each result
    const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 0);

    return results.sort((a, b) => {
      const aCount = queryTerms.reduce((sum, term) => {
        return sum + (a.content.toLowerCase().split(term).length - 1);
      }, 0);
      const bCount = queryTerms.reduce((sum, term) => {
        return sum + (b.content.toLowerCase().split(term).length - 1);
      }, 0);
      return bCount - aCount;  // Higher count first
    });
  }

  /**
   * Search with highlighted matches
   */
  searchWithHighlights(
    query: string,
    options: HighlightOptions = {}
  ): HighlightResult[] {
    const { openTag = "<mark>", closeTag = "</mark>" } = options;
    const results = this.db.search(query);

    // Extract search terms (handle phrases and operators)
    const terms = this.extractSearchTerms(query);

    return results.map((result) => {
      let highlighted = result.content;
      for (const term of terms) {
        const regex = new RegExp(`(${this.escapeRegex(term)})`, "gi");
        highlighted = highlighted.replace(regex, `${openTag}$1${closeTag}`);
      }
      return { ...result, highlighted };
    });
  }

  /**
   * Search with relevant snippets
   */
  searchWithSnippets(query: string): SnippetResult[] {
    const results = this.db.search(query);
    const terms = this.extractSearchTerms(query);

    return results.map((result) => {
      // For single-line documents, snippet is the content with highlight
      let snippet = result.content;
      for (const term of terms) {
        const regex = new RegExp(`(${this.escapeRegex(term)})`, "gi");
        snippet = snippet.replace(regex, "<mark>$1</mark>");
      }
      return { ...result, snippet };
    });
  }

  /**
   * Execute multiple searches efficiently
   */
  searchBatch(queries: string[]): Record<string, SearchResult[]> {
    const results: Record<string, SearchResult[]> = {};
    for (const query of queries) {
      results[query] = this.search(query);
    }
    return results;
  }

  /**
   * Convert simple grep pattern to FTS5 query
   * Falls back to regex for complex patterns
   */
  grepToFTS(pattern: string): SearchResult[] {
    // Check if pattern is a simple word or phrase
    if (/^[\w\s]+$/.test(pattern)) {
      // Simple word/phrase - use FTS5 directly
      return this.search(pattern);
    }

    // Handle alternation pattern: error|warning
    if (/^\w+(\|\w+)+$/.test(pattern)) {
      const terms = pattern.split("|");
      const ftsQuery = terms.join(" OR ");
      return this.search(ftsQuery);
    }

    // Complex regex - fall back to manual search
    return this.regexFallback(pattern);
  }

  /**
   * Fallback regex search when FTS5 can't handle the pattern
   */
  private regexFallback(pattern: string): SearchResult[] {
    try {
      const regex = new RegExp(pattern, "gi");
      const allLines = this.db.getLines(1, this.db.getLineCount());

      return allLines.filter((line) => regex.test(line.content));
    } catch {
      // Invalid regex
      return [];
    }
  }

  /**
   * Extract actual search terms from FTS5 query
   */
  private extractSearchTerms(query: string): string[] {
    // Remove FTS5 operators and extract plain terms
    const cleaned = query
      .replace(/\bAND\b/gi, " ")
      .replace(/\bOR\b/gi, " ")
      .replace(/\bNOT\b/gi, " ")
      .replace(/\bNEAR\b/gi, " ")
      .replace(/[()]/g, " ")
      .replace(/"/g, "");

    return cleaned
      .split(/\s+/)
      .filter((t) => t.length > 0 && !/^\d+$/.test(t));
  }

  /**
   * Escape special regex characters
   */
  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
}
