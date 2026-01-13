/**
 * Relational Synthesis Engine (evalo)
 *
 * A Barliman-inspired synthesis engine that uses miniKanren
 * to synthesize data extraction programs from examples.
 *
 * Key capabilities:
 * 1. Backwards reasoning - synthesize extractors from examples
 * 2. Early pruning - reject impossible extractors via type inference
 * 3. Formal guarantees - if synthesis succeeds, extractor provably works
 * 4. JavaScript compilation - convert to efficient runtime code
 */

// Types
export type { Extractor, Example, Type, Value } from "./types.js";
export { typeOf, isLeaf, children } from "./types.js";

// Evaluation and Synthesis
export { evalExtractor, evalo, synthesizeExtractor, synthesizeSimplest } from "./evalo.js";

// Type Inference
export { inferType, canProduceType, possibleTypes, filterByType, typeOfValue } from "./typeo.js";

// Compilation
export { compile, compileToFunction, compileToFunctionString, prettyPrint } from "./compile.js";
