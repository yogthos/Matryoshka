import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ParserRegistry } from "../../src/treesitter/parser-registry.js";
import {
  getLanguageForExtension,
  getSupportedExtensions,
  isExtensionSupported,
  isLanguageAvailable,
} from "../../src/treesitter/language-map.js";

describe("Language Map", () => {
  it("should return correct language for TypeScript extensions", () => {
    expect(getLanguageForExtension(".ts")).toBe("typescript");
    expect(getLanguageForExtension(".tsx")).toBe("typescript");
    expect(getLanguageForExtension(".mts")).toBe("typescript");
  });

  it("should return correct language for JavaScript extensions", () => {
    expect(getLanguageForExtension(".js")).toBe("javascript");
    expect(getLanguageForExtension(".jsx")).toBe("javascript");
    expect(getLanguageForExtension(".mjs")).toBe("javascript");
  });

  it("should return correct language for Python extensions", () => {
    expect(getLanguageForExtension(".py")).toBe("python");
    expect(getLanguageForExtension(".pyi")).toBe("python");
  });

  it("should return correct language for Go extensions", () => {
    expect(getLanguageForExtension(".go")).toBe("go");
  });

  it("should return null for unknown extensions", () => {
    // Extensions with no built-in config
    expect(getLanguageForExtension(".txt")).toBeNull();
    expect(getLanguageForExtension(".xyz")).toBeNull();
    expect(getLanguageForExtension(".unknown")).toBeNull();
  });

  it("should return language for extensions with built-in configs", () => {
    // These have configs but packages may not be installed
    expect(getLanguageForExtension(".rs")).toBe("rust");
    expect(getLanguageForExtension(".java")).toBe("java");
    expect(getLanguageForExtension(".html")).toBe("html");
    expect(getLanguageForExtension(".json")).toBe("json");
  });

  it("should be case-insensitive for extensions", () => {
    expect(getLanguageForExtension(".TS")).toBe("typescript");
    expect(getLanguageForExtension(".Py")).toBe("python");
  });

  it("should return all supported extensions", () => {
    const extensions = getSupportedExtensions();
    expect(extensions).toContain(".ts");
    expect(extensions).toContain(".js");
    expect(extensions).toContain(".py");
    expect(extensions).toContain(".go");
    expect(extensions.length).toBeGreaterThanOrEqual(10);
  });

  it("should check extension support", () => {
    // isExtensionSupported returns true if a config exists (not if package is installed)
    expect(isExtensionSupported(".ts")).toBe(true);
    expect(isExtensionSupported(".java")).toBe(true); // Has built-in config
    expect(isExtensionSupported(".txt")).toBe(false); // No config
    expect(isExtensionSupported(".xyz")).toBe(false); // No config
  });

  it("should check language availability (package installed)", () => {
    // These packages are installed
    expect(isLanguageAvailable("typescript")).toBe(true);
    expect(isLanguageAvailable("python")).toBe(true);
    expect(isLanguageAvailable("go")).toBe(true);
    expect(isLanguageAvailable("javascript")).toBe(true);
    // These have configs but packages aren't installed
    expect(isLanguageAvailable("rust")).toBe(false);
    expect(isLanguageAvailable("java")).toBe(false);
  });
});

describe("ParserRegistry", () => {
  let registry: ParserRegistry;

  beforeAll(async () => {
    registry = new ParserRegistry();
    await registry.init();
  });

  afterAll(() => {
    registry.dispose();
  });

  describe("initialization", () => {
    it("should initialize WASM runtime", async () => {
      expect(registry.isInitialized()).toBe(true);
    });

    it("should report supported extensions", () => {
      const extensions = registry.getSupportedExtensions();
      expect(extensions).toContain(".ts");
      expect(extensions).toContain(".js");
      expect(extensions).toContain(".py");
      expect(extensions).toContain(".go");
    });
  });

  describe("TypeScript parsing", () => {
    it("should parse TypeScript and return tree", async () => {
      const code = `
function hello(name: string): string {
  return "Hello, " + name;
}
`;
      const tree = await registry.parseDocument(code, ".ts");
      expect(tree).not.toBeNull();
      expect(tree!.rootNode).toBeDefined();
      expect(tree!.rootNode.type).toBe("program");
    });

    it("should parse TypeScript class", async () => {
      const code = `
class Greeter {
  private name: string;

  constructor(name: string) {
    this.name = name;
  }

  greet(): string {
    return "Hello, " + this.name;
  }
}
`;
      const tree = await registry.parseDocument(code, ".ts");
      expect(tree).not.toBeNull();

      // Check that the tree has the expected structure
      const rootNode = tree!.rootNode;
      const classNode = rootNode.child(0);
      expect(classNode?.type).toBe("class_declaration");
    });

    it("should parse TypeScript interface", async () => {
      const code = `
interface Person {
  name: string;
  age: number;
}

type ID = string | number;
`;
      const tree = await registry.parseDocument(code, ".ts");
      expect(tree).not.toBeNull();
      expect(tree!.rootNode.childCount).toBeGreaterThanOrEqual(2);
    });
  });

  describe("JavaScript parsing", () => {
    it("should parse JavaScript and return tree", async () => {
      const code = `
function add(a, b) {
  return a + b;
}

const multiply = (a, b) => a * b;
`;
      const tree = await registry.parseDocument(code, ".js");
      expect(tree).not.toBeNull();
      expect(tree!.rootNode.type).toBe("program");
    });
  });

  describe("Python parsing", () => {
    it("should parse Python and return tree", async () => {
      const code = `
def hello(name):
    return f"Hello, {name}"

class Greeter:
    def __init__(self, name):
        self.name = name

    def greet(self):
        return f"Hello, {self.name}"
`;
      const tree = await registry.parseDocument(code, ".py");
      expect(tree).not.toBeNull();
      expect(tree!.rootNode.type).toBe("module");
    });

    it("should parse Python function definitions", async () => {
      const code = `
def calculate(x, y):
    return x + y
`;
      const tree = await registry.parseDocument(code, ".py");
      expect(tree).not.toBeNull();

      const rootNode = tree!.rootNode;
      // Find function definition
      const funcNode = rootNode.children.find(
        (c) => c.type === "function_definition"
      );
      expect(funcNode).toBeDefined();
    });
  });

  describe("Go parsing", () => {
    it("should parse Go and return tree", async () => {
      const code = `
package main

func hello(name string) string {
    return "Hello, " + name
}

type Person struct {
    Name string
    Age  int
}

func (p *Person) Greet() string {
    return "Hello, " + p.Name
}
`;
      const tree = await registry.parseDocument(code, ".go");
      expect(tree).not.toBeNull();
      expect(tree!.rootNode.type).toBe("source_file");
    });
  });

  describe("error handling", () => {
    it("should handle parse errors gracefully", async () => {
      // Invalid code with syntax errors
      const code = `
function incomplete(
  // missing closing paren and body
`;
      // Should not throw, returns tree with ERROR nodes
      const tree = await registry.parseDocument(code, ".ts");
      expect(tree).not.toBeNull();
      // Tree should have error nodes but still parse
      expect(tree!.rootNode).toBeDefined();
    });

    it("should throw for unavailable language (package not installed)", async () => {
      const code = "fn main() {}";
      // Rust has a config but package isn't installed
      await expect(registry.parseDocument(code, ".rs")).rejects.toThrow(
        /not available/
      );
    });

    it("should throw for unknown extension", async () => {
      const code = "some content";
      await expect(registry.parseDocument(code, ".xyz")).rejects.toThrow(
        /Unsupported extension/
      );
    });

    it("should handle empty content", async () => {
      const tree = await registry.parseDocument("", ".ts");
      expect(tree).not.toBeNull();
      expect(tree!.rootNode.childCount).toBe(0);
    });
  });

  describe("lazy loading", () => {
    it("should lazy-load grammar on first parse", async () => {
      // Create a fresh registry to test lazy loading
      const freshRegistry = new ParserRegistry();
      await freshRegistry.init();

      // First parse should load the grammar
      const tree1 = await freshRegistry.parseDocument("const x = 1;", ".ts");
      expect(tree1).not.toBeNull();

      // Second parse should reuse the loaded grammar
      const tree2 = await freshRegistry.parseDocument("const y = 2;", ".ts");
      expect(tree2).not.toBeNull();

      freshRegistry.dispose();
    });
  });
});
