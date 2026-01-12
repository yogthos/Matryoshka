/**
 * Lightweight fuzzy search implementation using Bitap algorithm
 * This is bundled as a string to inject into the sandbox (no external modules)
 */

export const FUZZY_SEARCH_IMPL = `
/**
 * Bitap (Shift-Or) fuzzy search algorithm
 * Returns matches with scores (lower = better match)
 */
function fuzzySearch(lines, query, limit = 10) {
  if (!query || query.length === 0) return [];

  const results = [];
  const queryLower = query.toLowerCase();
  const maxDistance = Math.floor(query.length * 0.4); // 40% error tolerance

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    const lineLower = line.toLowerCase();

    // Exact substring match (score = 0)
    if (lineLower.includes(queryLower)) {
      results.push({ line, lineNum: i + 1, score: 0 });
      continue;
    }

    // Fuzzy match using simplified Levenshtein distance
    const score = fuzzyScore(lineLower, queryLower, maxDistance);
    if (score <= maxDistance) {
      results.push({ line, lineNum: i + 1, score: score / query.length });
    }
  }

  // Sort by score (lower is better) and limit results
  results.sort((a, b) => a.score - b.score);
  return results.slice(0, limit);
}

/**
 * Calculate fuzzy match score using sliding window approach
 * Returns Infinity if no good match found
 */
function fuzzyScore(text, pattern, maxDistance) {
  const patternLen = pattern.length;
  const textLen = text.length;

  if (patternLen === 0) return 0;
  if (textLen === 0) return Infinity;

  // If text is much shorter than pattern, no good match possible
  const minRequiredLength = patternLen - maxDistance;
  if (textLen < minRequiredLength) return Infinity;

  let bestScore = Infinity;

  // Slide pattern over text (ensure non-negative upper bound)
  const maxStart = Math.max(0, textLen - patternLen + maxDistance);
  for (let start = 0; start <= maxStart; start++) {
    let errors = 0;
    let matched = 0;
    let j = start;

    for (let i = 0; i < patternLen && j < textLen; i++) {
      if (text[j] === pattern[i]) {
        matched++;
        j++;
      } else {
        // Try skip in text
        if (j + 1 < textLen && text[j + 1] === pattern[i]) {
          errors++;
          j += 2;
          matched++;
        }
        // Try skip in pattern (deletion)
        else if (i + 1 < patternLen && text[j] === pattern[i + 1]) {
          errors++;
          i++;
          j++;
          matched++;
        }
        // Substitution
        else {
          errors++;
          j++;
        }
      }

      if (errors > maxDistance) break;
    }

    if (matched >= patternLen - maxDistance) {
      bestScore = Math.min(bestScore, errors);
    }
  }

  return bestScore;
}

// Expose as global function
const fuzzy_search = (query, limit = 10) => fuzzySearch(__linesArray, query, limit);
`;

/**
 * Standalone fuzzy search function for use outside sandbox
 */
export function fuzzySearchStandalone(
  lines: string[],
  query: string,
  limit = 10
): Array<{ line: string; lineNum: number; score: number }> {
  if (!query || query.length === 0) return [];

  const results: Array<{ line: string; lineNum: number; score: number }> = [];
  const queryLower = query.toLowerCase();
  const maxDistance = Math.floor(query.length * 0.4);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    const lineLower = line.toLowerCase();

    // Exact substring match
    if (lineLower.includes(queryLower)) {
      results.push({ line, lineNum: i + 1, score: 0 });
      continue;
    }

    // Simple fuzzy: count matching characters
    let matches = 0;
    let queryIdx = 0;
    for (let j = 0; j < lineLower.length && queryIdx < queryLower.length; j++) {
      if (lineLower[j] === queryLower[queryIdx]) {
        matches++;
        queryIdx++;
      }
    }

    const score = 1 - matches / queryLower.length;
    if (score <= 0.6) {
      // 60% match threshold
      results.push({ line, lineNum: i + 1, score });
    }
  }

  results.sort((a, b) => a.score - b.score);
  return results.slice(0, limit);
}
