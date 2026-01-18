/**
 * Built-in grammar configurations
 *
 * These are shipped with matryoshka and don't require user configuration.
 * Users can override these or add new languages via ~/.matryoshka/config.json
 */

import type { SymbolKind } from "./types.js";

/**
 * Built-in grammar configuration
 */
export interface BuiltinGrammar {
  /** npm package name */
  package: string;
  /** File extensions */
  extensions: string[];
  /** AST node type to symbol kind mapping */
  symbols: Record<string, SymbolKind>;
  /** How to extract grammar from module (for special cases like TypeScript) */
  moduleExport?: string;
}

/**
 * All built-in grammar configurations
 */
export const BUILTIN_GRAMMARS: Record<string, BuiltinGrammar> = {
  // === Original languages ===
  typescript: {
    package: "tree-sitter-typescript",
    extensions: [".ts", ".tsx", ".mts", ".cts"],
    moduleExport: "typescript",
    symbols: {
      function_declaration: "function",
      method_definition: "method",
      class_declaration: "class",
      interface_declaration: "interface",
      type_alias_declaration: "type",
      enum_declaration: "enum",
      variable_declarator: "variable",
      lexical_declaration: "variable",
      public_field_definition: "property",
    },
  },

  javascript: {
    package: "tree-sitter-javascript",
    extensions: [".js", ".jsx", ".mjs", ".cjs"],
    symbols: {
      function_declaration: "function",
      method_definition: "method",
      class_declaration: "class",
      variable_declarator: "variable",
      lexical_declaration: "variable",
      field_definition: "property",
    },
  },

  python: {
    package: "tree-sitter-python",
    extensions: [".py", ".pyw", ".pyi"],
    symbols: {
      function_definition: "function",
      class_definition: "class",
      // Methods are function_definition inside classes - handled specially
    },
  },

  go: {
    package: "tree-sitter-go",
    extensions: [".go"],
    symbols: {
      function_declaration: "function",
      method_declaration: "method",
      // type_declaration handled specially for struct/interface detection
    },
  },

  // === New languages ===
  rust: {
    package: "tree-sitter-rust",
    extensions: [".rs"],
    symbols: {
      function_item: "function",
      impl_item: "class", // impl blocks are like classes
      struct_item: "struct",
      enum_item: "enum",
      trait_item: "interface",
      type_item: "type",
      const_item: "constant",
      static_item: "variable",
      mod_item: "module",
      macro_definition: "function",
    },
  },

  c: {
    package: "tree-sitter-c",
    extensions: [".c", ".h"],
    symbols: {
      function_definition: "function",
      function_declarator: "function",
      struct_specifier: "struct",
      enum_specifier: "enum",
      type_definition: "type",
    },
  },

  cpp: {
    package: "tree-sitter-cpp",
    extensions: [".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx", ".h++"],
    symbols: {
      function_definition: "function",
      class_specifier: "class",
      struct_specifier: "struct",
      enum_specifier: "enum",
      type_definition: "type",
      namespace_definition: "namespace",
      template_declaration: "function",
    },
  },

  java: {
    package: "tree-sitter-java",
    extensions: [".java"],
    symbols: {
      method_declaration: "method",
      class_declaration: "class",
      interface_declaration: "interface",
      enum_declaration: "enum",
      constructor_declaration: "method",
      field_declaration: "property",
    },
  },

  ruby: {
    package: "tree-sitter-ruby",
    extensions: [".rb", ".rake", ".gemspec"],
    symbols: {
      method: "method",
      singleton_method: "method",
      class: "class",
      module: "module",
      constant: "constant",
    },
  },

  sql: {
    package: "tree-sitter-sql",
    extensions: [".sql"],
    symbols: {
      create_table_statement: "struct",
      create_view_statement: "type",
      create_function_statement: "function",
      create_procedure_statement: "function",
      create_index_statement: "variable",
    },
  },

  html: {
    package: "tree-sitter-html",
    extensions: [".html", ".htm"],
    symbols: {
      // HTML doesn't have traditional "symbols" - these capture structure
      element: "type",
      script_element: "function",
      style_element: "type",
    },
  },

  css: {
    package: "tree-sitter-css",
    extensions: [".css"],
    symbols: {
      rule_set: "type",
      media_statement: "namespace",
      keyframes_statement: "function",
      supports_statement: "type",
      import_statement: "module",
    },
  },

  json: {
    package: "tree-sitter-json",
    extensions: [".json"],
    symbols: {
      // JSON is data, not code - minimal symbol extraction
      pair: "property",
    },
  },

  yaml: {
    package: "tree-sitter-yaml",
    extensions: [".yaml", ".yml"],
    symbols: {
      // YAML is data, not code - minimal symbol extraction
      block_mapping_pair: "property",
    },
  },

  bash: {
    package: "tree-sitter-bash",
    extensions: [".sh", ".bash", ".zsh"],
    symbols: {
      function_definition: "function",
      variable_assignment: "variable",
    },
  },

  // Additional common languages (mappings ready, install package to use)
  php: {
    package: "tree-sitter-php",
    extensions: [".php"],
    symbols: {
      function_definition: "function",
      method_declaration: "method",
      class_declaration: "class",
      interface_declaration: "interface",
      trait_declaration: "class",
      const_declaration: "constant",
      property_declaration: "property",
    },
  },

  csharp: {
    package: "tree-sitter-c-sharp",
    extensions: [".cs"],
    symbols: {
      method_declaration: "method",
      class_declaration: "class",
      interface_declaration: "interface",
      struct_declaration: "struct",
      enum_declaration: "enum",
      property_declaration: "property",
      field_declaration: "variable",
      namespace_declaration: "namespace",
    },
  },

  kotlin: {
    package: "tree-sitter-kotlin",
    extensions: [".kt", ".kts"],
    symbols: {
      function_declaration: "function",
      class_declaration: "class",
      object_declaration: "class",
      interface_declaration: "interface",
      property_declaration: "property",
    },
  },

  swift: {
    package: "tree-sitter-swift",
    extensions: [".swift"],
    symbols: {
      function_declaration: "function",
      class_declaration: "class",
      struct_declaration: "struct",
      protocol_declaration: "interface",
      enum_declaration: "enum",
      typealias_declaration: "type",
    },
  },

  scala: {
    package: "tree-sitter-scala",
    extensions: [".scala", ".sc"],
    symbols: {
      function_definition: "function",
      class_definition: "class",
      object_definition: "class",
      trait_definition: "interface",
      type_definition: "type",
      val_definition: "constant",
      var_definition: "variable",
    },
  },

  lua: {
    package: "tree-sitter-lua",
    extensions: [".lua"],
    symbols: {
      function_declaration: "function",
      local_function: "function",
      function_definition: "function",
      variable_declaration: "variable",
    },
  },

  haskell: {
    package: "tree-sitter-haskell",
    extensions: [".hs", ".lhs"],
    symbols: {
      function: "function",
      type_alias: "type",
      data: "type",
      newtype: "type",
      class: "interface",
      instance: "method",
    },
  },

  elixir: {
    package: "tree-sitter-elixir",
    extensions: [".ex", ".exs"],
    symbols: {
      call: "function", // def, defp, defmodule, etc.
    },
  },

  clojure: {
    package: "tree-sitter-clojure",
    extensions: [".clj", ".cljs", ".cljc", ".edn"],
    symbols: {
      list_lit: "function", // defn, def, etc.
    },
  },

  toml: {
    package: "tree-sitter-toml",
    extensions: [".toml"],
    symbols: {
      table: "namespace",
      pair: "property",
    },
  },

  markdown: {
    package: "tree-sitter-markdown",
    extensions: [".md", ".markdown"],
    symbols: {
      atx_heading: "type",
      setext_heading: "type",
    },
  },
};

/**
 * Get a built-in grammar by language name
 */
export function getBuiltinGrammar(language: string): BuiltinGrammar | undefined {
  return BUILTIN_GRAMMARS[language];
}

/**
 * Get all built-in language names
 */
export function getBuiltinLanguages(): string[] {
  return Object.keys(BUILTIN_GRAMMARS);
}

/**
 * Check if a language has built-in support
 */
export function isBuiltinLanguage(language: string): boolean {
  return language in BUILTIN_GRAMMARS;
}
