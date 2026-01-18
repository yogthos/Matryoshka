import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ParserRegistry } from "../../src/treesitter/parser-registry.js";
import { SymbolExtractor } from "../../src/treesitter/symbol-extractor.js";
import type { Symbol } from "../../src/treesitter/types.js";

describe("SymbolExtractor", () => {
  let registry: ParserRegistry;
  let extractor: SymbolExtractor;

  beforeAll(async () => {
    registry = new ParserRegistry();
    await registry.init();
    extractor = new SymbolExtractor(registry);
  });

  afterAll(() => {
    registry.dispose();
  });

  describe("TypeScript", () => {
    it("should extract function declarations", async () => {
      const code = `
function hello(name: string): string {
  return "Hello, " + name;
}

function goodbye(): void {
  console.log("Goodbye");
}
`;
      const symbols = await extractor.extractSymbols(code, ".ts");

      expect(symbols.length).toBeGreaterThanOrEqual(2);
      const funcNames = symbols.filter((s) => s.kind === "function").map((s) => s.name);
      expect(funcNames).toContain("hello");
      expect(funcNames).toContain("goodbye");
    });

    it("should extract class and methods", async () => {
      const code = `
class Greeter {
  private name: string;

  constructor(name: string) {
    this.name = name;
  }

  greet(): string {
    return "Hello, " + this.name;
  }

  farewell(): void {
    console.log("Goodbye");
  }
}
`;
      const symbols = await extractor.extractSymbols(code, ".ts");

      // Should have class
      const classes = symbols.filter((s) => s.kind === "class");
      expect(classes.length).toBe(1);
      expect(classes[0].name).toBe("Greeter");

      // Should have methods
      const methods = symbols.filter((s) => s.kind === "method");
      const methodNames = methods.map((s) => s.name);
      expect(methodNames).toContain("greet");
      expect(methodNames).toContain("farewell");
    });

    it("should capture parent-child relationships", async () => {
      const code = `
class Parent {
  childMethod(): void {
    // method body
  }
}
`;
      const symbols = await extractor.extractSymbols(code, ".ts");

      const parentClass = symbols.find((s) => s.name === "Parent" && s.kind === "class");
      const childMethod = symbols.find((s) => s.name === "childMethod" && s.kind === "method");

      expect(parentClass).toBeDefined();
      expect(childMethod).toBeDefined();

      // Method should reference parent class
      if (parentClass && childMethod) {
        expect(childMethod.parentSymbolId).toBe(parentClass.id);
      }
    });

    it("should extract interfaces and types", async () => {
      const code = `
interface Person {
  name: string;
  age: number;
}

type ID = string | number;

interface Employee extends Person {
  department: string;
}
`;
      const symbols = await extractor.extractSymbols(code, ".ts");

      const interfaces = symbols.filter((s) => s.kind === "interface");
      expect(interfaces.length).toBe(2);
      const interfaceNames = interfaces.map((s) => s.name);
      expect(interfaceNames).toContain("Person");
      expect(interfaceNames).toContain("Employee");

      const types = symbols.filter((s) => s.kind === "type");
      expect(types.length).toBe(1);
      expect(types[0].name).toBe("ID");
    });

    it("should track accurate line numbers", async () => {
      const code = `// Line 1
// Line 2
function test(): void { // Line 3
  // Line 4
} // Line 5
`;
      const symbols = await extractor.extractSymbols(code, ".ts");

      const testFunc = symbols.find((s) => s.name === "test");
      expect(testFunc).toBeDefined();
      expect(testFunc!.startLine).toBe(3);
      expect(testFunc!.endLine).toBe(5);
    });

    it("should extract arrow functions assigned to variables", async () => {
      const code = `
const add = (a: number, b: number): number => a + b;

const multiply = (a: number, b: number): number => {
  return a * b;
};
`;
      const symbols = await extractor.extractSymbols(code, ".ts");

      // Arrow functions assigned to const are typically extracted as variables
      const varNames = symbols.filter((s) => s.kind === "variable" || s.kind === "function").map((s) => s.name);
      expect(varNames.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("JavaScript", () => {
    it("should extract function declarations", async () => {
      const code = `
function add(a, b) {
  return a + b;
}

const multiply = function(a, b) {
  return a * b;
};
`;
      const symbols = await extractor.extractSymbols(code, ".js");

      const funcNames = symbols.filter((s) => s.kind === "function" || s.kind === "variable").map((s) => s.name);
      expect(funcNames).toContain("add");
    });

    it("should extract class definitions", async () => {
      const code = `
class Calculator {
  add(a, b) {
    return a + b;
  }
}
`;
      const symbols = await extractor.extractSymbols(code, ".js");

      const classes = symbols.filter((s) => s.kind === "class");
      expect(classes.length).toBe(1);
      expect(classes[0].name).toBe("Calculator");
    });
  });

  describe("Python", () => {
    it("should extract function definitions", async () => {
      const code = `
def hello(name):
    return f"Hello, {name}"

def goodbye():
    print("Goodbye")
`;
      const symbols = await extractor.extractSymbols(code, ".py");

      const funcNames = symbols.filter((s) => s.kind === "function").map((s) => s.name);
      expect(funcNames).toContain("hello");
      expect(funcNames).toContain("goodbye");
    });

    it("should extract class definitions", async () => {
      const code = `
class Greeter:
    def __init__(self, name):
        self.name = name

    def greet(self):
        return f"Hello, {self.name}"
`;
      const symbols = await extractor.extractSymbols(code, ".py");

      const classes = symbols.filter((s) => s.kind === "class");
      expect(classes.length).toBe(1);
      expect(classes[0].name).toBe("Greeter");

      const methods = symbols.filter((s) => s.kind === "method");
      expect(methods.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("Go", () => {
    it("should extract function declarations", async () => {
      const code = `
package main

func hello(name string) string {
    return "Hello, " + name
}

func add(a, b int) int {
    return a + b
}
`;
      const symbols = await extractor.extractSymbols(code, ".go");

      const funcNames = symbols.filter((s) => s.kind === "function").map((s) => s.name);
      expect(funcNames).toContain("hello");
      expect(funcNames).toContain("add");
    });

    it("should extract struct and methods", async () => {
      const code = `
package main

type Person struct {
    Name string
    Age  int
}

func (p *Person) Greet() string {
    return "Hello, " + p.Name
}
`;
      const symbols = await extractor.extractSymbols(code, ".go");

      const structs = symbols.filter((s) => s.kind === "struct");
      expect(structs.length).toBe(1);
      expect(structs[0].name).toBe("Person");

      const methods = symbols.filter((s) => s.kind === "method");
      expect(methods.length).toBe(1);
      expect(methods[0].name).toBe("Greet");
    });
  });

  describe("error handling", () => {
    it("should return empty array for parse errors", async () => {
      const code = `
function incomplete(
  // missing closing paren and body
`;
      const symbols = await extractor.extractSymbols(code, ".ts");
      // Should not throw, may return partial results or empty
      expect(Array.isArray(symbols)).toBe(true);
    });

    it("should throw for unsupported extension", async () => {
      await expect(extractor.extractSymbols("code", ".rs")).rejects.toThrow();
    });
  });
});
