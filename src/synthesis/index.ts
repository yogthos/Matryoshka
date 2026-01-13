/**
 * Synthesis Module Index
 * Exports all synthesis-related functionality
 */

// Core miniKanren
export {
  LVar,
  Goal,
  Substitution,
  unify,
  eq,
  conj,
  disj,
  conde,
  fresh,
  run,
  reify,
  walk,
  walkStar,
  occurs,
} from "./minikanren/core.js";

// Regex synthesis
export {
  synthesizeRegex,
  RegexNode,
  RegexSynthesisRequest,
  RegexSynthesisResult,
  astToRegex,
  regexNodeToString,
} from "./regex/synthesis.js";

// Extractor synthesis
export {
  synthesizeExtractor,
  Extractor,
  ExtractorRequest,
  ExtractorTemplate,
  EXTRACTOR_TEMPLATES,
} from "./extractor/synthesis.js";

// Knowledge base
export {
  KnowledgeBase,
  SynthesizedComponent,
} from "./knowledge-base.js";

// Evolutionary synthesizer
export {
  EvolutionarySynthesizer,
  PartialProgram,
} from "./evolutionary.js";

// Coordinator
export {
  SynthesisCoordinator,
  CollectedExample,
  SynthesisRequest,
  SynthesisResult,
} from "./coordinator.js";

// Example collector
export {
  collectExamplesFromResult,
  extractGrepResults,
  extractNumberExamples,
  extractKeyValueExamples,
  parseLogLine,
  SandboxResult,
  GrepResult,
  NumberExample,
  KeyValueExample,
  ParsedLogLine,
} from "./example-collector.js";

// Sandbox tools with synthesis
export {
  createSandboxWithSynthesis,
  SandboxWithSynthesis,
} from "./sandbox-tools.js";
