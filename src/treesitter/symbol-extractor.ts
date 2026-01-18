/**
 * SymbolExtractor - Extracts symbols from source code using Tree-sitter
 *
 * Walks the syntax tree and identifies functions, classes, methods,
 * interfaces, types, and other symbol definitions.
 */

import { ParserRegistry } from "./parser-registry.js";
import type { Symbol, SymbolKind, SupportedLanguage } from "./types.js";

/**
 * Node types that represent symbol definitions in each language
 */
const SYMBOL_NODE_TYPES: Record<SupportedLanguage, Record<string, SymbolKind>> = {
  typescript: {
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
  javascript: {
    function_declaration: "function",
    method_definition: "method",
    class_declaration: "class",
    variable_declarator: "variable",
    lexical_declaration: "variable",
    field_definition: "property",
  },
  python: {
    function_definition: "function",
    class_definition: "class",
    // Methods are also function_definition but inside classes
  },
  go: {
    function_declaration: "function",
    method_declaration: "method",
    // type_declaration is handled separately (contains type_spec with struct_type)
  },
};

/**
 * Name field mappings for different node types
 */
const NAME_FIELDS: Record<string, string[]> = {
  function_declaration: ["name"],
  function_definition: ["name"],
  method_definition: ["name"],
  method_declaration: ["name"],
  class_declaration: ["name"],
  class_definition: ["name"],
  interface_declaration: ["name"],
  type_alias_declaration: ["name"],
  type_spec: ["name"],
  enum_declaration: ["name"],
  variable_declarator: ["name"],
  public_field_definition: ["name"],
  field_definition: ["name"],
};

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

    // Walk the tree and extract symbols
    this.walkTree(tree.rootNode, language, symbols, null);

    return symbols;
  }

  /**
   * Recursively walk the syntax tree and extract symbols
   */
  private walkTree(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    node: any,
    language: SupportedLanguage,
    symbols: Symbol[],
    parentId: number | null
  ): void {
    const nodeTypes = SYMBOL_NODE_TYPES[language];
    let currentParentId = parentId;

    // Check if this node is a symbol definition
    if (nodeTypes[node.type]) {
      const symbol = this.extractSymbolFromNode(node, language, parentId);
      if (symbol) {
        symbols.push(symbol);
        // If this is a container (class, struct), use its ID for children
        if (this.isContainer(node.type)) {
          currentParentId = symbol.id!;
        }
      }
    } else if (language === "python" && node.type === "function_definition") {
      // Python: check if this is a method (inside a class)
      const symbol = this.extractSymbolFromNode(node, language, parentId);
      if (symbol) {
        // If parent is a class, this is a method
        if (parentId !== null) {
          symbol.kind = "method";
        }
        symbols.push(symbol);
      }
    } else if (language === "go" && node.type === "type_declaration") {
      // Go: extract type declaration (struct, interface, etc.)
      const symbol = this.extractGoTypeDeclaration(node, parentId);
      if (symbol) {
        symbols.push(symbol);
      }
    }

    // Recurse into children
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) {
        this.walkTree(child, language, symbols, currentParentId);
      }
    }
  }

  /**
   * Extract a symbol from a node
   */
  private extractSymbolFromNode(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    node: any,
    language: SupportedLanguage,
    parentId: number | null
  ): Symbol | null {
    const nodeTypes = SYMBOL_NODE_TYPES[language];
    let kind = nodeTypes[node.type];

    // Special case for Python function_definition
    if (language === "python" && node.type === "function_definition") {
      kind = parentId !== null ? "method" : "function";
    }

    if (!kind) return null;

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

    // Check if it's a struct
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
      if (child && (child.type === "identifier" || child.type === "type_identifier" || child.type === "property_identifier")) {
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
    if (
      node.type === "function_declaration" ||
      node.type === "method_definition" ||
      node.type === "function_definition" ||
      node.type === "method_declaration"
    ) {
      // Get the text up to the opening brace or colon
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

  /**
   * Check if a node type is a container (can have child symbols)
   */
  private isContainer(nodeType: string): boolean {
    return (
      nodeType === "class_declaration" ||
      nodeType === "class_definition" ||
      nodeType === "interface_declaration" ||
      nodeType === "type_spec"
    );
  }
}
