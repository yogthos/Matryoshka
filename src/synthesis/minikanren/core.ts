/**
 * miniKanren core implementation in TypeScript
 * A minimal logic programming system for program synthesis
 */

/**
 * Logic Variable - represents an unbound variable in logic programming
 */
export class LVar {
  constructor(public readonly name: string) {}

  toString(): string {
    return `_.${this.name}`;
  }
}

/**
 * Substitution - maps logic variables to values
 */
export type Substitution = Map<LVar, unknown>;

/**
 * Goal - a function that takes a substitution and returns a stream of substitutions
 */
export type Goal = (s: Substitution) => Substitution[];

/**
 * Walk through the substitution to find the value of a term
 * If term is an LVar, follow the chain of bindings
 */
export function walk(term: unknown, s: Substitution): unknown {
  if (term instanceof LVar) {
    const val = s.get(term);
    if (val !== undefined) {
      return walk(val, s);
    }
    return term;
  }
  return term;
}

/**
 * Extend substitution with a new binding
 */
function extend(x: LVar, v: unknown, s: Substitution): Substitution {
  const newS = new Map(s);
  newS.set(x, v);
  return newS;
}

/**
 * Unify two terms, returning a new substitution or null if unification fails
 */
export function unify(
  u: unknown,
  v: unknown,
  s: Substitution
): Substitution | null {
  const uWalked = walk(u, s);
  const vWalked = walk(v, s);

  // Same value (including same LVar reference)
  if (uWalked === vWalked) {
    return s;
  }

  // LVar cases
  if (uWalked instanceof LVar) {
    return extend(uWalked, vWalked, s);
  }
  if (vWalked instanceof LVar) {
    return extend(vWalked, uWalked, s);
  }

  // Array unification
  if (Array.isArray(uWalked) && Array.isArray(vWalked)) {
    if (uWalked.length !== vWalked.length) {
      return null;
    }
    let currentS: Substitution | null = s;
    for (let i = 0; i < uWalked.length; i++) {
      currentS = unify(uWalked[i], vWalked[i], currentS);
      if (currentS === null) {
        return null;
      }
    }
    return currentS;
  }

  // Object unification (plain objects only)
  if (
    typeof uWalked === "object" &&
    uWalked !== null &&
    !Array.isArray(uWalked) &&
    typeof vWalked === "object" &&
    vWalked !== null &&
    !Array.isArray(vWalked)
  ) {
    const uObj = uWalked as Record<string, unknown>;
    const vObj = vWalked as Record<string, unknown>;
    const uKeys = Object.keys(uObj).sort();
    const vKeys = Object.keys(vObj).sort();

    // Check same keys
    if (uKeys.length !== vKeys.length) {
      return null;
    }
    for (let i = 0; i < uKeys.length; i++) {
      if (uKeys[i] !== vKeys[i]) {
        return null;
      }
    }

    // Unify values
    let currentS: Substitution | null = s;
    for (const key of uKeys) {
      currentS = unify(uObj[key], vObj[key], currentS);
      if (currentS === null) {
        return null;
      }
    }
    return currentS;
  }

  // Primitive values that are not equal
  return null;
}

/**
 * Equality goal - succeeds when u and v can be unified
 */
export function eq(u: unknown, v: unknown): Goal {
  return (s: Substitution) => {
    const result = unify(u, v, s);
    return result !== null ? [result] : [];
  };
}

/**
 * Conjunction - all goals must succeed
 * Returns the combined substitutions from all goals
 */
export function conj(...goals: Goal[]): Goal {
  if (goals.length === 0) {
    // Empty conjunction succeeds with identity
    return (s: Substitution) => [s];
  }

  return (s: Substitution) => {
    let results: Substitution[] = [s];

    for (const goal of goals) {
      const nextResults: Substitution[] = [];
      for (const sub of results) {
        const goalResults = goal(sub);
        nextResults.push(...goalResults);
      }
      results = nextResults;

      // Short-circuit if no results
      if (results.length === 0) {
        return [];
      }
    }

    return results;
  };
}

/**
 * Disjunction - any goal can succeed
 * Returns all substitutions from all succeeding goals
 */
export function disj(...goals: Goal[]): Goal {
  if (goals.length === 0) {
    // Empty disjunction fails
    return () => [];
  }

  return (s: Substitution) => {
    const results: Substitution[] = [];
    for (const goal of goals) {
      results.push(...goal(s));
    }
    return results;
  };
}

/**
 * Fresh - create fresh logic variables and pass them to a goal constructor
 */
export function fresh(
  goalFn: (...vars: LVar[]) => Goal,
  numVars: number = 1
): Goal {
  return (s: Substitution) => {
    // Create fresh variables with unique names
    const vars: LVar[] = [];
    for (let i = 0; i < numVars; i++) {
      vars.push(new LVar(`_fresh_${freshCounter++}`));
    }
    const goal = goalFn(...vars);
    return goal(s);
  };
}

let freshCounter = 0;

/**
 * Run a goal and return up to maxResults substitutions
 */
export function run(goal: Goal, maxResults: number = 10): Substitution[] {
  const emptyS = new Map<LVar, unknown>();
  const results = goal(emptyS);
  return results.slice(0, maxResults);
}

/**
 * Reify a term - walk through substitution and replace LVars with their values
 * Returns the fully resolved value, or a string representation for unbound LVars
 */
export function reify(term: unknown, s: Substitution): unknown {
  const walked = walk(term, s);

  if (walked instanceof LVar) {
    // Unbound variable - return its string representation
    return walked.toString();
  }

  if (Array.isArray(walked)) {
    return walked.map((item) => reify(item, s));
  }

  if (
    typeof walked === "object" &&
    walked !== null &&
    !Array.isArray(walked)
  ) {
    const obj = walked as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) {
      result[key] = reify(obj[key], s);
    }
    return result;
  }

  return walked;
}
