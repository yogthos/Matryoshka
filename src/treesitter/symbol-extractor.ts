/**
 * SymbolExtractor - Extracts symbols from source code using Tree-sitter
 *
 * Walks the syntax tree and identifies functions, classes, methods,
 * interfaces, types, and other symbol definitions.
 * Supports both built-in and custom language configurations.
 */

import { ParserRegistry } from "./parser-registry.js";
import type { Symbol, SymbolKind, SupportedLanguage } from "./types.js";
import { getSymbolMappings } from "./language-map.js";

/**
 * Name field mappings for different node types
 */
const NAME_FIELDS: Record<string, string[]> = {
  // Functions
  function_declaration: ["name"],
  function_definition: ["name"],
  function_item: ["name"],
  method_definition: ["name"],
  method_declaration: ["name"],
  // Classes/types
  class_declaration: ["name"],
  class_definition: ["name"],
  class_specifier: ["name"],
  interface_declaration: ["name"],
  type_alias_declaration: ["name"],
  type_spec: ["name"],
  type_definition: ["name"],
  type_item: ["name"],
  struct_item: ["name"],
  struct_specifier: ["name"],
  enum_declaration: ["name"],
  enum_item: ["name"],
  enum_specifier: ["name"],
  trait_item: ["name"],
  impl_item: ["name", "trait", "type"],
  // Variables
  variable_declarator: ["name"],
  const_item: ["name"],
  static_item: ["name"],
  // Properties
  public_field_definition: ["name"],
  field_definition: ["name"],
  property_declaration: ["name"],
  // Modules
  mod_item: ["name"],
  namespace_definition: ["name"],
  module: ["name"],
  // SQL
  create_table_statement: ["name", "table_name"],
  create_function_statement: ["name", "function_name"],
  // Generic fallback
  pair: ["key"],
  block_mapping_pair: ["key"],
};

/**
 * Node types that are containers (can have child symbols)
 */
const CONTAINER_TYPES = new Set([
  "class_declaration",
  "class_definition",
  "class_specifier",
  "interface_declaration",
  "type_spec",
  "impl_item",
  "trait_item",
  "struct_item",
  "module",
  "mod_item",
  "namespace_definition",
]);

/**
 * SymbolExtractor extracts symbols from source code
 */
export class SymbolExtractor {
  private registry: ParserRegistry;
  private symbolIdCounter: number = 0;

  constructor(registry: ParserRegistry) {
    this.registry = registry;
  }

  /**
   * Extract all symbols from source code
   */
  async extractSymbols(content: string, ext: string): Promise<Symbol[]> {
    const result = await this.registry.parseWithLanguage(content, ext);
    if (!result) {
      throw new Error(`Unsupported extension: ${ext}`);
    }

    const { tree, language } = result;
    const symbols: Symbol[] = [];
    this.symbolIdCounter = 0;

    // Get symbol mappings for this language
    const symbolMappings = getSymbolMappings(language);
    if (!symbolMappings) {
      // No symbol mappings - return empty
      return [];
    }

    // Walk the tree and extract symbols
    this.walkTree(tree.rootNode, language, symbolMappings, symbols, null);

    return symbols;
  }

  /**
   * Recursively walk the syntax tree and extract symbols
   */
  private walkTree(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    node: any,
    language: SupportedLanguage,
    symbolMappings: Record<string, SymbolKind>,
    symbols: Symbol[],
    parentId: number | null
  ): void {
    let currentParentId = parentId;

    // Special case: Python - handle classes and methods correctly
    if (language === "python") {
      if (node.type === "class_definition") {
        const symbol = this.extractSymbolFromNode(node, "class", parentId, language);
        if (symbol) {
          symbols.push(symbol);
          currentParentId = symbol.id!;
        }
      } else if (node.type === "function_definition") {
        const pythonKind: SymbolKind = parentId !== null ? "method" : "function";
        const symbol = this.extractSymbolFromNode(node, pythonKind, parentId, language);
        if (symbol) {
          symbols.push(symbol);
        }
      }
    } else if (language === "go" && node.type === "type_declaration") {
      // Go: type_declaration contains type_spec
      const symbol = this.extractGoTypeDeclaration(node, parentId);
      if (symbol) {
        symbols.push(symbol);
      }
    } else {
      // Check if this node is a symbol definition using the mappings
      const kind = symbolMappings[node.type];
      if (kind) {
        const symbol = this.extractSymbolFromNode(node, kind, parentId, language);
        if (symbol) {
          symbols.push(symbol);
          // If this is a container, use its ID for children
          if (CONTAINER_TYPES.has(node.type)) {
            currentParentId = symbol.id!;
          }
        }
      }
    }

    // Recurse into children
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) {
        this.walkTree(child, language, symbolMappings, symbols, currentParentId);
      }
    }
  }

  /**
   * Extract a symbol from a node
   */
  private extractSymbolFromNode(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    node: any,
    kind: SymbolKind,
    parentId: number | null,
    language: SupportedLanguage
  ): Symbol | null {
    const name = this.getNodeName(node);
    if (!name) return null;

    this.symbolIdCounter++;

    return {
      id: this.symbolIdCounter,
      name,
      kind,
      startLine: node.startPosition.row + 1, // Convert to 1-indexed
      endLine: node.endPosition.row + 1,
      startCol: node.startPosition.column,
      endCol: node.endPosition.column,
      signature: this.getSignature(node, language),
      parentSymbolId: parentId,
    };
  }

  /**
   * Extract a Go type_declaration (contains type_spec with struct_type, etc.)
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private extractGoTypeDeclaration(node: any, parentId: number | null): Symbol | null {
    // Find the type_spec child
    let typeSpec = null;
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child && child.type === "type_spec") {
        typeSpec = child;
        break;
      }
    }

    if (!typeSpec) return null;

    // Get name from type_spec
    const name = this.getNodeName(typeSpec);
    if (!name) return null;

    // Check if it's a struct or interface
    let kind: SymbolKind = "type";
    for (let i = 0; i < typeSpec.childCount; i++) {
      const child = typeSpec.child(i);
      if (child && child.type === "struct_type") {
        kind = "struct";
        break;
      } else if (child && child.type === "interface_type") {
        kind = "interface";
        break;
      }
    }

    this.symbolIdCounter++;

    return {
      id: this.symbolIdCounter,
      name,
      kind,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      startCol: node.startPosition.column,
      endCol: node.endPosition.column,
      parentSymbolId: parentId,
    };
  }

  /**
   * Get the name of a node
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private getNodeName(node: any): string | null {
    const fields = NAME_FIELDS[node.type];

    if (fields) {
      for (const field of fields) {
        const nameNode = node.childForFieldName(field);
        if (nameNode) {
          return nameNode.text;
        }
      }
    }

    // Fallback: look for identifier or type_identifier child
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (
        child &&
        (child.type === "identifier" ||
          child.type === "type_identifier" ||
          child.type === "property_identifier")
      ) {
        return child.text;
      }
    }

    return null;
  }

  /**
   * Get a signature string for a symbol
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private getSignature(node: any, language: SupportedLanguage): string | undefined {
    // For functions/methods, try to get the signature from the first line
    const functionTypes = [
      "function_declaration",
      "method_definition",
      "function_definition",
      "method_declaration",
      "function_item",
    ];

    if (functionTypes.includes(node.type)) {
      const text = node.text as string;
      const lines = text.split("\n");
      if (lines.length > 0) {
        let firstLine = lines[0];
        // Clean up the signature
        if (language === "python") {
          const colonIndex = firstLine.indexOf(":");
          if (colonIndex !== -1) {
            firstLine = firstLine.substring(0, colonIndex + 1);
          }
        } else {
          const braceIndex = firstLine.indexOf("{");
          if (braceIndex !== -1) {
            firstLine = firstLine.substring(0, braceIndex).trim();
          }
        }
        return firstLine.trim();
      }
    }
    return undefined;
  }
}
