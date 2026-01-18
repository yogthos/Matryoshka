import { describe, it, expect, beforeEach } from "vitest";
import { EXAMPLE_CONFIG } from "../../src/config/grammar-config.js";
import {
  getAllLanguageConfigs,
  getLanguageForExtension,
  isExtensionSupported,
  clearLanguageCache,
} from "../../src/treesitter/language-map.js";
import { BUILTIN_GRAMMARS } from "../../src/treesitter/builtin-grammars.js";

describe("Grammar Configuration", () => {
  describe("Built-in Grammars", () => {
    it("should have TypeScript, JavaScript, Python, Go as built-in", () => {
      expect(BUILTIN_GRAMMARS.typescript).toBeDefined();
      expect(BUILTIN_GRAMMARS.javascript).toBeDefined();
      expect(BUILTIN_GRAMMARS.python).toBeDefined();
      expect(BUILTIN_GRAMMARS.go).toBeDefined();
    });

    it("should have SQL, HTML, CSS, JSON, YAML as built-in", () => {
      expect(BUILTIN_GRAMMARS.sql).toBeDefined();
      expect(BUILTIN_GRAMMARS.html).toBeDefined();
      expect(BUILTIN_GRAMMARS.css).toBeDefined();
      expect(BUILTIN_GRAMMARS.json).toBeDefined();
      expect(BUILTIN_GRAMMARS.yaml).toBeDefined();
    });

    it("should have Rust, C, C++, Java as built-in configs", () => {
      expect(BUILTIN_GRAMMARS.rust).toBeDefined();
      expect(BUILTIN_GRAMMARS.c).toBeDefined();
      expect(BUILTIN_GRAMMARS.cpp).toBeDefined();
      expect(BUILTIN_GRAMMARS.java).toBeDefined();
    });

    it("should include correct extensions for each language", () => {
      expect(BUILTIN_GRAMMARS.typescript.extensions).toContain(".ts");
      expect(BUILTIN_GRAMMARS.typescript.extensions).toContain(".tsx");
      expect(BUILTIN_GRAMMARS.python.extensions).toContain(".py");
      expect(BUILTIN_GRAMMARS.rust.extensions).toContain(".rs");
      expect(BUILTIN_GRAMMARS.html.extensions).toContain(".html");
    });

    it("should include symbol mappings for each language", () => {
      expect(BUILTIN_GRAMMARS.typescript.symbols.function_declaration).toBe("function");
      expect(BUILTIN_GRAMMARS.python.symbols.class_definition).toBe("class");
      expect(BUILTIN_GRAMMARS.rust.symbols.function_item).toBe("function");
    });

    it("should include package names for each language", () => {
      expect(BUILTIN_GRAMMARS.typescript.package).toBe("tree-sitter-typescript");
      expect(BUILTIN_GRAMMARS.python.package).toBe("tree-sitter-python");
      expect(BUILTIN_GRAMMARS.rust.package).toBe("tree-sitter-rust");
    });
  });

  describe("Language Map Integration", () => {
    beforeEach(() => {
      clearLanguageCache();
    });

    it("should return all language configs", () => {
      const configs = getAllLanguageConfigs();
      expect(Object.keys(configs).length).toBeGreaterThan(15);
      expect(configs.typescript).toBeDefined();
      expect(configs.rust).toBeDefined();
    });

    it("should map extensions to languages", () => {
      expect(getLanguageForExtension(".ts")).toBe("typescript");
      expect(getLanguageForExtension(".rs")).toBe("rust");
      expect(getLanguageForExtension(".html")).toBe("html");
      expect(getLanguageForExtension(".json")).toBe("json");
    });

    it("should check extension support", () => {
      expect(isExtensionSupported(".ts")).toBe(true);
      expect(isExtensionSupported(".rs")).toBe(true);
      expect(isExtensionSupported(".html")).toBe(true);
      expect(isExtensionSupported(".xyz")).toBe(false);
    });
  });

  describe("Example Config", () => {
    it("should have valid structure", () => {
      expect(EXAMPLE_CONFIG).toBeDefined();
      expect(EXAMPLE_CONFIG.grammars).toBeDefined();
      expect(EXAMPLE_CONFIG.grammars!.rust).toBeDefined();
    });

    it("should have valid Rust config", () => {
      const rust = EXAMPLE_CONFIG.grammars!.rust;
      expect(rust.package).toBe("tree-sitter-rust");
      expect(rust.extensions).toContain(".rs");
      expect(rust.symbols.function_item).toBe("function");
    });
  });
});

describe("New Language Support", () => {
  it("should support HTML parsing with installed package", async () => {
    const { ParserRegistry } = await import("../../src/treesitter/parser-registry.js");
    const registry = new ParserRegistry();
    await registry.init();

    const htmlCode = `<!DOCTYPE html>
<html>
  <head><title>Test</title></head>
  <body><h1>Hello</h1></body>
</html>`;

    const tree = await registry.parseDocument(htmlCode, ".html");
    expect(tree).not.toBeNull();
    expect(tree!.rootNode.type).toBe("document");

    registry.dispose();
  });

  it("should support JSON parsing with installed package", async () => {
    const { ParserRegistry } = await import("../../src/treesitter/parser-registry.js");
    const registry = new ParserRegistry();
    await registry.init();

    const jsonCode = `{
  "name": "test",
  "version": "1.0.0"
}`;

    const tree = await registry.parseDocument(jsonCode, ".json");
    expect(tree).not.toBeNull();
    expect(tree!.rootNode.type).toBe("document");

    registry.dispose();
  });

  it("should support CSS parsing with installed package", async () => {
    const { ParserRegistry } = await import("../../src/treesitter/parser-registry.js");
    const registry = new ParserRegistry();
    await registry.init();

    const cssCode = `
.container {
  display: flex;
  padding: 10px;
}

#header {
  background: blue;
}`;

    const tree = await registry.parseDocument(cssCode, ".css");
    expect(tree).not.toBeNull();
    expect(tree!.rootNode.type).toBe("stylesheet");

    registry.dispose();
  });

  // Note: tree-sitter-yaml exports a different format that's not compatible
  // with native tree-sitter bindings. It works with web-tree-sitter (WASM).
  // Skip for now until we have a compatible version.
  it.skip("should support YAML parsing with installed package", async () => {
    const { ParserRegistry } = await import("../../src/treesitter/parser-registry.js");
    const registry = new ParserRegistry();
    await registry.init();

    const yamlCode = `
name: test
version: 1.0.0
dependencies:
  - foo
  - bar`;

    const tree = await registry.parseDocument(yamlCode, ".yaml");
    expect(tree).not.toBeNull();
    expect(tree!.rootNode.type).toBe("stream");

    registry.dispose();
  });
});
