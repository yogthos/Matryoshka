/**
 * Knowledge Base for Few-Shot Nucleus RAG
 *
 * Contains "Golden" Lambda Calculus examples for the Nucleus solver.
 * These examples show the CORRECT approach: compose LC primitives
 * to express intent, letting the solver do the work.
 *
 * IMPORTANT: Use LC syntax, not JavaScript!
 */

/**
 * A single expert example with metadata for retrieval
 */
export interface ExpertExample {
  id: string;
  category: TaskCategory;
  keywords: string[];
  description: string;
  code: string;
  rationale: string;
  pitfalls?: string[];
}

export type TaskCategory =
  | "aggregation"
  | "extraction"
  | "search"
  | "transformation"
  | "analysis"
  | "currency"
  | "classification"
  | "list";

export interface FailureExample {
  intent: string;
  badCode: string;
  error: string;
  fix: string;
}

/**
 * Expert examples using Nucleus LC approach
 */
export const EXPERT_EXAMPLES: ExpertExample[] = [
  // ============================================
  // CLASSIFICATION PATTERNS - Finding items that match criteria
  // ============================================
  {
    id: "classify-status",
    category: "classification",
    keywords: ["find", "failed", "error", "success", "status", "filter", "match", "which"],
    description: "Find items matching a status/criteria",
    code: `; Turn 1: Search broadly
(grep "webhook")

; Turn 2: After seeing results, compose filter
(filter (grep "webhook") (λ line (match line "failed" 0)))

; Or provide examples to solver
(classify
  "[10:00] ERROR: Webhook delivery failed - id=WH-123" true
  "[10:01] INFO: Webhook queued for retry - id=WH-123" false)`,
    rationale: "Use filter with lambda predicate, or classify with input/output examples. Copy EXACT lines from grep output.",
    pitfalls: [
      "Copy exact lines from grep output, don't make up examples",
      "Need both positive (true) and negative (false) examples",
      "Use filter/classify, not raw JavaScript"
    ]
  },
  {
    id: "classify-type",
    category: "classification",
    keywords: ["type", "category", "kind", "group", "sort"],
    description: "Classify items into categories",
    code: `; Search for items to categorize
(grep "ERROR")

; Then classify with examples from output
(classify
  "[10:00] ERROR: Database connection failed" "database"
  "[10:01] ERROR: API timeout occurred" "api"
  "[10:02] ERROR: File not found" "file")`,
    rationale: "Use classify with string outputs to categorize. Copy EXACT lines from grep output.",
    pitfalls: [
      "Need examples of each category you want to identify"
    ]
  },

  // ============================================
  // AGGREGATION PATTERNS - Summing/counting values
  // ============================================
  {
    id: "agg-currency-sum",
    category: "aggregation",
    keywords: ["total", "sum", "sales", "revenue", "money", "dollar", "$", "add up"],
    description: "Sum all currency values",
    code: `; Turn 1: Find lines with values
(grep "\\$")

; Turn 2: Extract numbers using map
(map (grep "\\$") (λ line (parseFloat (match line "[0-9,.]+" 0))))

; To sum, the solver will aggregate the mapped results`,
    rationale: "Use map to extract values, parseFloat to convert. Solver handles aggregation.",
    pitfalls: [
      "Use \\$ to match literal dollar sign in regex",
      "Replace commas before parsing: (replace ... \",\" \"\")"
    ]
  },
  {
    id: "agg-count",
    category: "aggregation",
    keywords: ["count", "how many", "number of"],
    description: "Count items matching criteria",
    code: `; Simple count: grep returns array, check length
(grep "ERROR")

; Filtered count: compose filter
(filter (grep "ERROR") (λ line (match line "CRITICAL" 0)))`,
    rationale: "grep returns array for counting. Use filter to narrow results.",
    pitfalls: []
  },

  // ============================================
  // SEARCH PATTERNS
  // ============================================
  {
    id: "search-basic",
    category: "search",
    keywords: ["find", "search", "look for", "locate", "where"],
    description: "Basic search with grep",
    code: `; Basic search
(grep "ERROR")

; Fuzzy search for approximate matches
(fuzzy_search "webhook" 10)

; Get document overview first
(text_stats)`,
    rationale: "grep for exact pattern, fuzzy_search for approximate. Use text_stats to understand document.",
    pitfalls: [
      "Search single keywords first, not phrases",
      "Use JSON.stringify() to see object contents"
    ]
  },
  {
    id: "search-broad-then-narrow",
    category: "search",
    keywords: ["not found", "zero results", "empty", "no matches"],
    description: "When search returns 0 results",
    code: `// If multi-word search fails, try single word
let hits = grep("failed webhook");  // might return 0
console.log("Multi-word:", hits.length);

if (hits.length === 0) {
  hits = grep("webhook");  // broader search
  console.log("Single word:", hits.length);
}

; Now filter to narrow results
(filter (fuzzy_search "payment" 20) (λ line (match line "failed" 0)))`,
    rationale: "Document phrasing may differ. Search broad with fuzzy_search, then filter.",
    pitfalls: [
      "Don't assume exact phrasing",
      "Single keywords work better than phrases"
    ]
  },

  // ============================================
  // EXTRACTION PATTERNS
  // ============================================
  {
    id: "extract-value",
    category: "extraction",
    keywords: ["extract", "get", "parse", "pull out", "value"],
    description: "Extract specific values from lines",
    code: `; Turn 1: Find lines with the pattern
(grep "id=")

; Turn 2: Extract values using map and match
(map (grep "id=") (λ line (match line "id=([A-Z0-9-]+)" 1)))`,
    rationale: "Use map with match to extract values from each line.",
    pitfalls: [
      "match group 1 captures the first parenthesized group",
      "Use map to apply extractor to all results"
    ]
  },

  // ============================================
  // LIST PATTERNS
  // ============================================
  {
    id: "list-items",
    category: "list",
    keywords: ["list", "all", "show", "enumerate"],
    description: "List all items matching a pattern",
    code: `; List all matching items
(grep "webhook")

; Or filter to specific items
(filter (grep "webhook") (λ line (match line "failed" 0)))`,
    rationale: "grep returns array of matches. Use filter to narrow if needed.",
    pitfalls: []
  }
];

/**
 * Common failure patterns to avoid
 */
export const FAILURE_EXAMPLES: FailureExample[] = [
  {
    intent: "Trying to write JavaScript code",
    badCode: `const failed = hits.filter(h => h.line.includes("failed"));`,
    error: "ERROR: Output LC terms, not JavaScript",
    fix: `Use filter with lambda:
(filter (grep "keyword") (λ line (match line "failed" 0)))`
  },
  {
    intent: "Repeating the same search",
    badCode: `(grep "keyword")
(grep "keyword")`,
    error: "ERROR: Repeated term",
    fix: `After grep, compose filter or classify:
(filter (grep "keyword") (λ line (match line "pattern" 0)))

Or provide examples:
(classify "line1" true "line2" false)`
  },
  {
    intent: "Writing code instead of composing terms",
    badCode: `const pattern = /\\d+/;`,
    error: "ERROR: No S-expression found",
    fix: "Use synthesize_extractor with input/output examples instead of regex."
  },
  {
    intent: "Output without JSON.stringify",
    badCode: `console.log(hits);`,
    error: "Shows [object Object] instead of content",
    fix: `console.log(JSON.stringify(hits, null, 2));`
  },
  {
    intent: "Return a value",
    badCode: `return total;`,
    error: "Return statement not in sandbox",
    fix: "Use console.log() to output, then <<<FINAL>>>answer<<<END>>>"
  }
];

export function getExamplesByCategory(category: TaskCategory): ExpertExample[] {
  return EXPERT_EXAMPLES.filter(ex => ex.category === category);
}

export function getAllKeywords(): Map<string, ExpertExample[]> {
  const keywordMap = new Map<string, ExpertExample[]>();
  for (const example of EXPERT_EXAMPLES) {
    for (const keyword of example.keywords) {
      const lower = keyword.toLowerCase();
      const existing = keywordMap.get(lower) || [];
      existing.push(example);
      keywordMap.set(lower, existing);
    }
  }
  return keywordMap;
}
