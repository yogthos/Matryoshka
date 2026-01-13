/**
 * Regex synthesis engine
 * Generates regex patterns from positive/negative examples
 */

// ============================================================================
// AST Types
// ============================================================================

export interface Literal {
  type: "literal";
  value: string;
}

export interface CharClass {
  type: "charClass";
  class: "digit" | "word" | "whitespace" | "any" | "alpha" | "alphaUpper" | "alphaLower" | "hex" | "custom";
  chars?: string; // For custom class
}

export interface Repeat {
  type: "repeat";
  child: RegexNode;
  min: number;
  max: number; // Use Infinity for unbounded
}

export interface Sequence {
  type: "sequence";
  children: RegexNode[];
}

export interface Alt {
  type: "alt";
  children: RegexNode[];
}

export interface Group {
  type: "group";
  child: RegexNode;
  capturing: boolean;
}

export type RegexNode = Literal | CharClass | Repeat | Sequence | Alt | Group;

// ============================================================================
// AST to Regex String Conversion
// ============================================================================

const REGEX_SPECIAL_CHARS = /[.*+?^${}()|[\]\\]/g;

function escapeRegex(str: string): string {
  return str.replace(REGEX_SPECIAL_CHARS, "\\$&");
}

export function nodeToRegex(node: RegexNode): string {
  switch (node.type) {
    case "literal":
      return escapeRegex(node.value);

    case "charClass":
      switch (node.class) {
        case "digit":
          return "\\d";
        case "word":
          return "\\w";
        case "whitespace":
          return "\\s";
        case "any":
          return ".";
        case "alpha":
          return "[a-zA-Z]";
        case "alphaUpper":
          return "[A-Z]";
        case "alphaLower":
          return "[a-z]";
        case "hex":
          return "[0-9A-Fa-f]";
        case "custom":
          return `[${escapeRegex(node.chars || "")}]`;
        default:
          return ".";
      }

    case "repeat": {
      const childRegex = nodeToRegex(node.child);
      const needsGroup = node.child.type === "sequence" || node.child.type === "alt";
      const wrapped = needsGroup ? `(?:${childRegex})` : childRegex;

      if (node.min === 0 && node.max === Infinity) {
        return `${wrapped}*`;
      } else if (node.min === 1 && node.max === Infinity) {
        return `${wrapped}+`;
      } else if (node.min === 0 && node.max === 1) {
        return `${wrapped}?`;
      } else if (node.min === node.max) {
        return `${wrapped}{${node.min}}`;
      } else if (node.max === Infinity) {
        return `${wrapped}{${node.min},}`;
      } else {
        return `${wrapped}{${node.min},${node.max}}`;
      }
    }

    case "sequence":
      return node.children.map(nodeToRegex).join("");

    case "alt":
      return node.children.map(nodeToRegex).join("|");

    case "group":
      if (node.capturing) {
        return `(${nodeToRegex(node.child)})`;
      } else {
        return `(?:${nodeToRegex(node.child)})`;
      }

    default:
      return "";
  }
}

// ============================================================================
// Template Matching
// ============================================================================

interface TemplatePattern {
  name: string;
  test: (examples: string[]) => boolean;
  build: (examples: string[]) => RegexNode;
}

const TEMPLATES: TemplatePattern[] = [
  // Integer pattern
  {
    name: "integer",
    test: (examples) => examples.every((e) => /^\d+$/.test(e)),
    build: () => ({
      type: "repeat",
      child: { type: "charClass", class: "digit" },
      min: 1,
      max: Infinity,
    }),
  },

  // Decimal pattern
  {
    name: "decimal",
    test: (examples) => examples.every((e) => /^\d+\.\d+$/.test(e)),
    build: () => ({
      type: "sequence",
      children: [
        { type: "repeat", child: { type: "charClass", class: "digit" }, min: 1, max: Infinity },
        { type: "literal", value: "." },
        { type: "repeat", child: { type: "charClass", class: "digit" }, min: 1, max: Infinity },
      ],
    }),
  },

  // Currency with dollar sign
  {
    name: "currency-dollar",
    test: (examples) => examples.every((e) => /^\$[\d,]+(\.\d{2})?$/.test(e)),
    build: () => ({
      type: "sequence",
      children: [
        { type: "literal", value: "$" },
        {
          type: "repeat",
          child: { type: "charClass", class: "custom", chars: "0123456789," },
          min: 1,
          max: Infinity,
        },
        {
          type: "repeat",
          child: {
            type: "sequence",
            children: [
              { type: "literal", value: "." },
              { type: "repeat", child: { type: "charClass", class: "digit" }, min: 2, max: 2 },
            ],
          },
          min: 0,
          max: 1,
        },
      ],
    }),
  },

  // Date YYYY-MM-DD
  {
    name: "date-iso",
    test: (examples) => examples.every((e) => /^\d{4}-\d{2}-\d{2}$/.test(e)),
    build: () => ({
      type: "sequence",
      children: [
        { type: "repeat", child: { type: "charClass", class: "digit" }, min: 4, max: 4 },
        { type: "literal", value: "-" },
        { type: "repeat", child: { type: "charClass", class: "digit" }, min: 2, max: 2 },
        { type: "literal", value: "-" },
        { type: "repeat", child: { type: "charClass", class: "digit" }, min: 2, max: 2 },
      ],
    }),
  },

  // Date MM/DD/YYYY
  {
    name: "date-us",
    test: (examples) => examples.every((e) => /^\d{2}\/\d{2}\/\d{4}$/.test(e)),
    build: () => ({
      type: "sequence",
      children: [
        { type: "repeat", child: { type: "charClass", class: "digit" }, min: 2, max: 2 },
        { type: "literal", value: "/" },
        { type: "repeat", child: { type: "charClass", class: "digit" }, min: 2, max: 2 },
        { type: "literal", value: "/" },
        { type: "repeat", child: { type: "charClass", class: "digit" }, min: 4, max: 4 },
      ],
    }),
  },

  // Time HH:MM:SS
  {
    name: "time",
    test: (examples) => examples.every((e) => /^\d{2}:\d{2}:\d{2}$/.test(e)),
    build: () => ({
      type: "sequence",
      children: [
        { type: "repeat", child: { type: "charClass", class: "digit" }, min: 2, max: 2 },
        { type: "literal", value: ":" },
        { type: "repeat", child: { type: "charClass", class: "digit" }, min: 2, max: 2 },
        { type: "literal", value: ":" },
        { type: "repeat", child: { type: "charClass", class: "digit" }, min: 2, max: 2 },
      ],
    }),
  },

  // Email-like pattern
  {
    name: "email",
    test: (examples) => examples.every((e) => /^[\w.+-]+@[\w.-]+\.[a-z]{2,}$/i.test(e)),
    build: () => ({
      type: "sequence",
      children: [
        { type: "repeat", child: { type: "charClass", class: "custom", chars: "a-zA-Z0-9.+-_" }, min: 1, max: Infinity },
        { type: "literal", value: "@" },
        { type: "repeat", child: { type: "charClass", class: "custom", chars: "a-zA-Z0-9.-" }, min: 1, max: Infinity },
        { type: "literal", value: "." },
        { type: "repeat", child: { type: "charClass", class: "alpha" }, min: 2, max: Infinity },
      ],
    }),
  },

  // IP address pattern
  {
    name: "ip-address",
    test: (examples) =>
      examples.every((e) => /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(e)),
    build: () => ({
      type: "sequence",
      children: [
        { type: "repeat", child: { type: "charClass", class: "digit" }, min: 1, max: 3 },
        { type: "literal", value: "." },
        { type: "repeat", child: { type: "charClass", class: "digit" }, min: 1, max: 3 },
        { type: "literal", value: "." },
        { type: "repeat", child: { type: "charClass", class: "digit" }, min: 1, max: 3 },
        { type: "literal", value: "." },
        { type: "repeat", child: { type: "charClass", class: "digit" }, min: 1, max: 3 },
      ],
    }),
  },

  // Hex color pattern
  {
    name: "hex-color",
    test: (examples) => examples.every((e) => /^#[0-9A-Fa-f]{6}$/.test(e)),
    build: () => ({
      type: "sequence",
      children: [
        { type: "literal", value: "#" },
        { type: "repeat", child: { type: "charClass", class: "hex" }, min: 6, max: 6 },
      ],
    }),
  },

  // Version number pattern (v1.2.3)
  {
    name: "version",
    test: (examples) => examples.every((e) => /^v\d+\.\d+\.\d+$/.test(e)),
    build: () => ({
      type: "sequence",
      children: [
        { type: "literal", value: "v" },
        { type: "repeat", child: { type: "charClass", class: "digit" }, min: 1, max: Infinity },
        { type: "literal", value: "." },
        { type: "repeat", child: { type: "charClass", class: "digit" }, min: 1, max: Infinity },
        { type: "literal", value: "." },
        { type: "repeat", child: { type: "charClass", class: "digit" }, min: 1, max: Infinity },
      ],
    }),
  },

  // Phone number pattern (XXX-XXXX)
  {
    name: "phone-simple",
    test: (examples) => examples.every((e) => /^\d{3}-\d{4}$/.test(e)),
    build: () => ({
      type: "sequence",
      children: [
        { type: "repeat", child: { type: "charClass", class: "digit" }, min: 3, max: 3 },
        { type: "literal", value: "-" },
        { type: "repeat", child: { type: "charClass", class: "digit" }, min: 4, max: 4 },
      ],
    }),
  },
];

export function matchTemplate(examples: string[]): RegexNode | null {
  if (examples.length === 0) return null;

  for (const template of TEMPLATES) {
    if (template.test(examples)) {
      return template.build(examples);
    }
  }

  return null;
}

// ============================================================================
// Character Analysis
// ============================================================================

function getCharType(char: string): "digit" | "upper" | "lower" | "other" {
  if (/\d/.test(char)) return "digit";
  if (/[A-Z]/.test(char)) return "upper";
  if (/[a-z]/.test(char)) return "lower";
  return "other";
}

function analyzePosition(examples: string[], pos: number): { type: "fixed" | "class"; value: string | CharClass["class"] } {
  const chars = examples.map((e) => e[pos]);
  const uniqueChars = [...new Set(chars)];

  // All same character at this position
  if (uniqueChars.length === 1) {
    return { type: "fixed", value: uniqueChars[0] };
  }

  // Check if all digits
  if (chars.every((c) => /\d/.test(c))) {
    return { type: "class", value: "digit" };
  }

  // Check if all uppercase
  if (chars.every((c) => /[A-Z]/.test(c))) {
    return { type: "class", value: "alphaUpper" };
  }

  // Check if all lowercase
  if (chars.every((c) => /[a-z]/.test(c))) {
    return { type: "class", value: "alphaLower" };
  }

  // Check if all alpha
  if (chars.every((c) => /[a-zA-Z]/.test(c))) {
    return { type: "class", value: "alpha" };
  }

  // Check if all word characters
  if (chars.every((c) => /\w/.test(c))) {
    return { type: "class", value: "word" };
  }

  return { type: "class", value: "any" };
}

export function analyzeCharacters(examples: string[]): RegexNode | null {
  if (examples.length === 0) return null;

  const lengths = examples.map((e) => e.length);
  const minLen = Math.min(...lengths);
  const maxLen = Math.max(...lengths);

  // Fixed length - analyze each position
  if (minLen === maxLen) {
    const children: RegexNode[] = [];
    let i = 0;

    while (i < minLen) {
      const analysis = analyzePosition(examples, i);

      if (analysis.type === "fixed") {
        // Collect consecutive fixed characters
        let literal = analysis.value as string;
        let j = i + 1;
        while (j < minLen) {
          const next = analyzePosition(examples, j);
          if (next.type === "fixed") {
            literal += next.value as string;
            j++;
          } else {
            break;
          }
        }
        children.push({ type: "literal", value: literal });
        i = j;
      } else {
        // Collect consecutive same-class characters
        const charClass = analysis.value as CharClass["class"];
        let count = 1;
        let j = i + 1;
        while (j < minLen) {
          const next = analyzePosition(examples, j);
          if (next.type === "class" && next.value === charClass) {
            count++;
            j++;
          } else {
            break;
          }
        }
        children.push({
          type: "repeat",
          child: { type: "charClass", class: charClass },
          min: count,
          max: count,
        });
        i = j;
      }
    }

    if (children.length === 1) {
      return children[0];
    }
    return { type: "sequence", children };
  }

  // Variable length - simpler analysis
  // Check overall character composition
  if (examples.every((e) => /^\d+$/.test(e))) {
    return {
      type: "repeat",
      child: { type: "charClass", class: "digit" },
      min: minLen,
      max: maxLen,
    };
  }

  if (examples.every((e) => /^[a-zA-Z]+$/.test(e))) {
    return {
      type: "repeat",
      child: { type: "charClass", class: "alpha" },
      min: minLen,
      max: maxLen,
    };
  }

  if (examples.every((e) => /^\w+$/.test(e))) {
    return {
      type: "repeat",
      child: { type: "charClass", class: "word" },
      min: minLen,
      max: maxLen,
    };
  }

  // Fallback: any character
  return {
    type: "repeat",
    child: { type: "charClass", class: "any" },
    min: minLen,
    max: maxLen,
  };
}

// ============================================================================
// Main Synthesis Function
// ============================================================================

export interface SynthesisInput {
  positives: string[];
  negatives: string[];
}

export interface SynthesisResult {
  success: boolean;
  pattern?: string;
  ast?: RegexNode;
  error?: string;
}

export function synthesizeRegex(input: SynthesisInput): SynthesisResult {
  const { positives, negatives } = input;

  // Validation
  if (positives.length === 0) {
    return { success: false, error: "No positive examples provided" };
  }

  // Check for conflicts
  const conflicts = positives.filter((p) => negatives.includes(p));
  if (conflicts.length > 0) {
    return {
      success: false,
      error: `Conflicting examples: ${conflicts.join(", ")}`,
    };
  }

  // Try template matching first
  let ast = matchTemplate(positives);

  // If no template matches, try character analysis
  if (!ast) {
    ast = analyzeCharacters(positives);
  }

  // If still no match, try literal alternation for small sets
  if (!ast && positives.length <= 10) {
    ast = {
      type: "alt",
      children: positives.map((p) => ({ type: "literal", value: p })),
    };
  }

  if (!ast) {
    return { success: false, error: "Could not synthesize pattern" };
  }

  const pattern = nodeToRegex(ast);
  const regex = new RegExp(`^${pattern}$`);

  // Verify positives match
  const failedPositives = positives.filter((p) => !regex.test(p));
  if (failedPositives.length > 0) {
    return {
      success: false,
      error: `Pattern fails to match positives: ${failedPositives.join(", ")}`,
    };
  }

  // Verify negatives don't match
  const matchedNegatives = negatives.filter((n) => regex.test(n));
  if (matchedNegatives.length > 0) {
    // Try to refine with literal alternation if few positives
    if (positives.length <= 10) {
      const altAst: Alt = {
        type: "alt",
        children: positives.map((p) => ({ type: "literal", value: p })),
      };
      const altPattern = nodeToRegex(altAst);
      const altRegex = new RegExp(`^${altPattern}$`);

      // Check if literal alternation avoids negatives
      const stillMatchedNegatives = negatives.filter((n) => altRegex.test(n));
      if (stillMatchedNegatives.length === 0) {
        return { success: true, pattern: altPattern, ast: altAst };
      }
    }

    return {
      success: false,
      error: `Pattern incorrectly matches negatives: ${matchedNegatives.join(", ")}`,
    };
  }

  return { success: true, pattern, ast };
}
