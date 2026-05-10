/**
 * Mechanical linter / repairer for Nucleus S-expression queries.
 *
 * LLMs occasionally emit queries with small, deterministic syntax mistakes —
 * a missing trailing `)`, an extra `)`, a sentence wrapping the expression.
 * Round-tripping these through another LLM turn is wasteful when the fix is
 * obvious. `lintAndRepair` does the obvious fix and reports what it changed,
 * letting the caller decide whether to substitute.
 *
 * Scope of repairs (intentionally conservative — incorrect "fixes" are worse
 * than asking the model to retry):
 *   - Strip prose before the first `(` and after the outermost balanced `)`.
 *   - Append missing close parens / brackets to balance the expression.
 *   - Strip surplus trailing close parens / brackets.
 *
 * Out of scope:
 *   - Unterminated string literals (we can't guess where the close-quote
 *     belongs without inventing semantics).
 *   - Missing open parens (ambiguous — the model often means an atom).
 *   - Smart-quote / unicode-bracket substitution (rare in practice).
 *
 * The returned `repaired` is null when no change is needed or the input is
 * not safely repairable. When non-null, it is guaranteed to differ from the
 * input. Callers must still run the repaired string through the real parser
 * — this module does not parse, only balance.
 */
export interface LintResult {
  /** The repaired query, or null if no repair was applied / possible. */
  repaired: string | null;
  /** Human-readable descriptions of each mechanical change applied. */
  repairs: string[];
}

/**
 * Scan `input` and produce a per-character classification of which positions
 * are "inside a string literal." This is the single source of truth for
 * "should this `(` count?" — every paren/bracket-counting pass consults it.
 *
 * The scanner mirrors `lc-parser.ts`'s lexer: `"` toggles string mode, `\`
 * escapes the next character. We do not interpret escape sequences here;
 * we only need to know which positions are inside string mode.
 *
 * Returns `null` if the string is unterminated (`"` opened but never closed)
 * — at that point structural counting is unreliable and we bail.
 */
function classifyStringPositions(input: string): boolean[] | null {
  const inString: boolean[] = new Array(input.length).fill(false);
  let active = false;
  let escaped = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (active) inString[i] = true;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      // The closing quote is part of the string for our purposes — but its
      // index after toggling matters less than balancing the state.
      active = !active;
    }
  }
  if (active) return null; // unterminated
  return inString;
}

/**
 * Trim "obvious" prose around an S-expression: anything before the first `(`
 * and anything after the position where the outermost expression closes.
 *
 * Refuses to strip a side that contains any Nucleus syntax character —
 * `(`, `[`, `]`, `"`, `⊗`. Without this guard we'd silently delete real
 * intent: an unbalanced constraint prefix like `[type=string ⊗ (expr)`
 * would lose its constraint, or a chained `(expr1)(expr2)` would lose
 * the second expression. Per the project rule (correctness > token cost),
 * we'd rather fall through to LLM retry than mangle the query.
 */
function stripSurroundingProse(
  input: string,
  inString: boolean[]
): { stripped: string; changed: boolean; leading: boolean; trailing: boolean } {
  // Characters that, if found in the candidate prose region, mean the
  // region is *not* mere prose — could be an unclosed constraint, a
  // stray string literal, or another expression. Refuse to strip.
  const NUCLEUS_SYNTAX_CHARS = /[()[\]"⊗]/;
  // Locate the first non-string `(`.
  let firstOpen = -1;
  for (let i = 0; i < input.length; i++) {
    if (!inString[i] && input[i] === "(") {
      firstOpen = i;
      break;
    }
  }
  if (firstOpen === -1) {
    return { stripped: input, changed: false, leading: false, trailing: false };
  }

  // Walk from firstOpen, tracking depth. The outermost expression closes
  // the first time depth returns to zero. If depth never returns to zero,
  // there is no outermost-end to trim against; defer to the balancer.
  let depth = 0;
  let outerClose = -1;
  for (let i = firstOpen; i < input.length; i++) {
    if (inString[i]) continue;
    const ch = input[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) {
        outerClose = i;
        break;
      }
      if (depth < 0) {
        // Stray ')' before the outer expression even opened — abandon
        // prose-stripping; balancer will deal with it.
        return { stripped: input, changed: false, leading: false, trailing: false };
      }
    }
  }

  const leadingText = firstOpen > 0 ? input.slice(0, firstOpen) : "";
  const leadingHasProse = leadingText.trim().length > 0;
  const leadingSafe =
    leadingHasProse && !NUCLEUS_SYNTAX_CHARS.test(leadingText);
  // If the leading region has prose but also contains Nucleus syntax,
  // it's not safely strippable — bail entirely so neither side is
  // touched (we don't want to half-repair into an even more confusing
  // shape for the caller).
  if (leadingHasProse && !leadingSafe) {
    return { stripped: input, changed: false, leading: false, trailing: false };
  }
  const leading = leadingSafe;

  if (outerClose === -1) {
    // Unclosed outermost expression — only strip leading prose. Trailing
    // prose (if any) is ambiguous: we don't know where the expr "should"
    // end.
    if (!leading) {
      return { stripped: input, changed: false, leading: false, trailing: false };
    }
    return {
      stripped: input.slice(firstOpen),
      changed: true,
      leading: true,
      trailing: false,
    };
  }

  const trailingText =
    outerClose < input.length - 1 ? input.slice(outerClose + 1) : "";
  const trailingHasProse = trailingText.trim().length > 0;
  const trailingSafe =
    trailingHasProse && !NUCLEUS_SYNTAX_CHARS.test(trailingText);
  if (trailingHasProse && !trailingSafe) {
    // Trailing region looks like another expression / quoted text — don't
    // silently drop it.
    return { stripped: input, changed: false, leading: false, trailing: false };
  }
  const trailing = trailingSafe;

  if (!leading && !trailing) {
    return { stripped: input, changed: false, leading: false, trailing: false };
  }

  return {
    stripped: input.slice(firstOpen, outerClose + 1),
    changed: true,
    leading,
    trailing,
  };
}

/**
 * Count net paren/bracket imbalance (ignoring positions inside strings).
 * Positive = unclosed (need more closers). Negative = surplus closers.
 * Returns null if at any point a closer appears with no matching opener
 * AND the surplus is not just trailing — i.e. a mid-expression stray
 * closer, which we don't try to fix.
 */
function bracketBalance(
  input: string,
  inString: boolean[]
): { parens: number; brackets: number; trailingExtraParens: number; trailingExtraBrackets: number } | null {
  let parens = 0;
  let brackets = 0;
  let trailingExtraParens = 0;
  let trailingExtraBrackets = 0;

  for (let i = 0; i < input.length; i++) {
    if (inString[i]) continue;
    const ch = input[i];
    if (ch === "(") parens++;
    else if (ch === ")") {
      parens--;
      if (parens < 0) {
        // Could be a trailing extra ')' — defer judgment until we know
        // whether anything non-whitespace, non-closer follows.
        // Stash the position; if everything afterward is just `)`/`]`/space,
        // we'll treat it as a trailing surplus.
        const rest = input.slice(i);
        if (/^[\s)\]]*$/.test(rest)) {
          // Count the trailing surplus closers.
          for (const c of rest) {
            if (c === ")") trailingExtraParens++;
            else if (c === "]") trailingExtraBrackets++;
          }
          return {
            parens: 0,
            brackets,
            trailingExtraParens,
            trailingExtraBrackets,
          };
        }
        // Mid-expression stray ')' — unrepairable here.
        return null;
      }
    } else if (ch === "[") brackets++;
    else if (ch === "]") {
      brackets--;
      if (brackets < 0) {
        const rest = input.slice(i);
        if (/^[\s)\]]*$/.test(rest)) {
          for (const c of rest) {
            if (c === ")") trailingExtraParens++;
            else if (c === "]") trailingExtraBrackets++;
          }
          return {
            parens,
            brackets: 0,
            trailingExtraParens,
            trailingExtraBrackets,
          };
        }
        return null;
      }
    }
  }
  return { parens, brackets, trailingExtraParens, trailingExtraBrackets };
}

/**
 * Main entry. See module-level doc for scope of repairs.
 */
export function lintAndRepair(input: string): LintResult {
  if (!input || input.trim().length === 0) {
    return { repaired: null, repairs: [] };
  }

  const inStringInitial = classifyStringPositions(input);
  if (inStringInitial === null) {
    // Unterminated string literal — bail. We won't guess where it ends.
    return { repaired: null, repairs: [] };
  }

  const repairs: string[] = [];
  const stripped = stripSurroundingProse(input, inStringInitial);
  let current = stripped.stripped;
  if (stripped.changed) {
    if (stripped.leading) repairs.push("stripped leading prose before first '('");
    if (stripped.trailing) repairs.push("stripped trailing prose after outermost ')'");
  }

  // Re-classify on the (possibly trimmed) text.
  const inString = classifyStringPositions(current);
  if (inString === null) {
    return { repaired: null, repairs: [] };
  }

  const balance = bracketBalance(current, inString);
  if (balance === null) {
    // Stray mid-expression closer — don't guess.
    return { repaired: null, repairs: [] };
  }

  // Strip trailing surplus closers.
  if (balance.trailingExtraParens > 0 || balance.trailingExtraBrackets > 0) {
    // Walk back from the end, removing whitespace and extra `)`/`]`
    // until we've removed exactly the surplus count.
    let parensToRemove = balance.trailingExtraParens;
    let bracketsToRemove = balance.trailingExtraBrackets;
    let end = current.length;
    while (end > 0 && (parensToRemove > 0 || bracketsToRemove > 0)) {
      const c = current[end - 1];
      if (/\s/.test(c)) {
        end--;
        continue;
      }
      if (c === ")" && parensToRemove > 0) {
        parensToRemove--;
        end--;
        continue;
      }
      if (c === "]" && bracketsToRemove > 0) {
        bracketsToRemove--;
        end--;
        continue;
      }
      break;
    }
    current = current.slice(0, end);
    const parts: string[] = [];
    if (balance.trailingExtraParens > 0) {
      parts.push(`${balance.trailingExtraParens} extra ')'`);
    }
    if (balance.trailingExtraBrackets > 0) {
      parts.push(`${balance.trailingExtraBrackets} extra ']'`);
    }
    repairs.push(`stripped trailing ${parts.join(" + ")}`);
  }

  // Append missing closers to balance the expression.
  if (balance.parens > 0 || balance.brackets > 0) {
    // Brackets nest inside parens here; we don't know the original
    // interleaving, so close in a stable order: brackets first, then
    // parens. This matches the common case `[constraint] ⊗ (expr` where
    // a missing `)` is at the very end.
    if (balance.brackets > 0) {
      current += "]".repeat(balance.brackets);
      repairs.push(
        `appended ${balance.brackets} missing ']' to balance brackets`
      );
    }
    if (balance.parens > 0) {
      current += ")".repeat(balance.parens);
      repairs.push(
        `appended ${balance.parens} missing ')' to balance parens`
      );
    }
  }

  if (current === input) {
    return { repaired: null, repairs: [] };
  }
  if (repairs.length === 0) {
    // Defensive: text changed via whitespace normalization but we
    // didn't record a repair — don't claim a fix.
    return { repaired: null, repairs: [] };
  }

  return { repaired: current, repairs };
}
