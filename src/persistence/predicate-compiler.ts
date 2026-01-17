/**
 * PredicateCompiler - Safely compile JS predicates to functions
 *
 * Converts predicate strings like "item.type === 'error'" into executable functions.
 * Also provides optional SQL conversion for database-level filtering.
 */

// Blacklist of dangerous operations
const DANGEROUS_PATTERNS = [
  /\bprocess\b/,
  /\brequire\b/,
  /\bimport\b/,
  /\beval\b/,
  /\bFunction\b/,
  /\bglobal\b/,
  /\bwindow\b/,
  /\bdocument\b/,
  /\bfetch\b/,
  /\bXMLHttpRequest\b/,
  /\bsetTimeout\b/,
  /\bsetInterval\b/,
  /\b__proto__\b/,
  /\bconstructor\s*\(/,
  /\bprototype\b/,
];

// Whitelist of allowed operations
const ALLOWED_PATTERNS = [
  /^item\./,                           // Property access
  /===?/,                              // Equality
  /!==?/,                              // Inequality
  /[<>]=?/,                            // Comparison
  /&&|\|\|/,                           // Logical operators
  /!/,                                 // Negation
  /\?\.?/,                             // Optional chaining
  /\.includes\s*\(/,                   // String/Array methods
  /\.startsWith\s*\(/,
  /\.endsWith\s*\(/,
  /\.test\s*\(/,                       // Regex test
  /\.match\s*\(/,                      // Regex match
  /\.toLowerCase\s*\(/,
  /\.toUpperCase\s*\(/,
  /\.trim\s*\(/,
  /\.length\b/,
  /\/.*\/[gimsuy]*\.test/,            // Regex literals
  /\d+/,                               // Numbers
  /['"][^'"]*['"]/,                    // String literals
  /true|false|null|undefined/,         // Boolean/null literals
  /\(\s*\)/,                           // Empty parens
  /\[\d+\]/,                           // Array indexing
];

export type PredicateFn = (item: unknown) => boolean;
export type TransformFn = (item: unknown) => unknown;

export class PredicateCompiler {
  /**
   * Compile a predicate string to a function
   */
  compile(predicate: string): PredicateFn {
    this.validate(predicate);

    // Create a sandboxed function
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function("item", `"use strict"; return (${predicate});`);

    return (item: unknown) => {
      try {
        return Boolean(fn(item));
      } catch {
        return false;
      }
    };
  }

  /**
   * Compile a transform expression to a function
   */
  compileTransform(expression: string): TransformFn {
    this.validate(expression);

    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function("item", `"use strict"; return (${expression});`);

    return (item: unknown) => {
      try {
        return fn(item);
      } catch {
        return null;
      }
    };
  }

  /**
   * Validate a predicate/expression for safety
   */
  private validate(code: string): void {
    if (!code || !code.trim()) {
      throw new Error("Empty predicate");
    }

    // Check for dangerous patterns
    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(code)) {
        throw new Error(`Dangerous operation detected: ${pattern}`);
      }
    }

    // For complex expressions, we do a basic syntax check
    try {
      // Use Function constructor to check syntax only
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      new Function("item", `"use strict"; return (${code});`);
    } catch (e) {
      throw new Error(`Invalid syntax: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Convert simple predicates to SQL WHERE conditions
   * Returns null if conversion is not possible
   */
  toSQLCondition(predicate: string): string | null {
    // Simple equality: item.field === 'value'
    const eqMatch = predicate.match(/^item\.(\w+)\s*===?\s*['"]([^'"]+)['"]$/);
    if (eqMatch) {
      const [, field, value] = eqMatch;
      return `json_extract(data, '$.${field}') = '${value}'`;
    }

    // String includes: item.field.includes('value')
    const includesMatch = predicate.match(/^item\.(\w+)\.includes\s*\(\s*['"]([^'"]+)['"]\s*\)$/);
    if (includesMatch) {
      const [, field, value] = includesMatch;
      return `json_extract(data, '$.${field}') LIKE '%${value}%'`;
    }

    // Numeric comparison: item.field > 100
    const numMatch = predicate.match(/^item\.(\w+)\s*([<>]=?|===?|!==?)\s*(-?\d+(?:\.\d+)?)$/);
    if (numMatch) {
      const [, field, op, value] = numMatch;
      const sqlOp = op === "===" || op === "==" ? "=" : op === "!==" || op === "!=" ? "!=" : op;
      return `CAST(json_extract(data, '$.${field}') AS REAL) ${sqlOp} ${value}`;
    }

    // Can't convert - use JS evaluation
    return null;
  }
}
