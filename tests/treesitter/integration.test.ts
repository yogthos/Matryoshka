import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { HandleSession } from "../../src/engine/handle-session.js";

describe("HandleSession - Symbol Integration", () => {
  let session: HandleSession;

  const sampleTypeScript = `
function hello(name: string): string {
  return "Hello, " + name;
}

class Greeter {
  private name: string;

  constructor(name: string) {
    this.name = name;
  }

  greet(): string {
    return hello(this.name);
  }

  farewell(): void {
    console.log("Goodbye");
  }
}

interface Person {
  name: string;
  age: number;
}

type ID = string | number;
`.trim();

  const samplePython = `
def hello(name):
    return f"Hello, {name}"

class Greeter:
    def __init__(self, name):
        self.name = name

    def greet(self):
        return hello(self.name)
`.trim();

  beforeEach(() => {
    session = new HandleSession();
  });

  afterEach(() => {
    session.close();
  });

  describe("auto-indexing on load", () => {
    it("should auto-index symbols on TypeScript file load", async () => {
      await session.loadContentWithSymbols(sampleTypeScript, "test.ts");

      const result = session.execute('(list_symbols)');
      expect(result.success).toBe(true);
      expect(result.handle).toBeDefined();

      const expanded = session.expand(result.handle!);
      expect(expanded.success).toBe(true);
      expect(expanded.data?.length).toBeGreaterThan(0);

      // Verify we have the expected symbols
      const symbols = expanded.data as Array<{ name: string; kind: string }>;
      const names = symbols.map(s => s.name);
      expect(names).toContain("hello");
      expect(names).toContain("Greeter");
    });

    it("should auto-index symbols on Python file load", async () => {
      await session.loadContentWithSymbols(samplePython, "test.py");

      const result = session.execute('(list_symbols)');
      expect(result.success).toBe(true);

      const expanded = session.expand(result.handle!);
      const symbols = expanded.data as Array<{ name: string; kind: string }>;
      const names = symbols.map(s => s.name);
      expect(names).toContain("hello");
      expect(names).toContain("Greeter");
    });

    it("should handle non-code files gracefully", async () => {
      const plainText = "This is just plain text\nWith multiple lines\nNo code here";
      await session.loadContentWithSymbols(plainText, "readme.txt");

      // list_symbols should return empty array, not fail
      const result = session.execute('(list_symbols)');
      expect(result.success).toBe(true);

      // Either handle is empty or returns empty array
      if (result.handle) {
        const expanded = session.expand(result.handle);
        expect(expanded.data).toHaveLength(0);
      } else {
        // Scalar empty array or similar
        expect(result.value).toEqual([]);
      }
    });

    it("should update symbols on document reload", async () => {
      // Load initial content
      await session.loadContentWithSymbols(sampleTypeScript, "test.ts");
      let result = session.execute('(list_symbols "function")');
      expect(result.success).toBe(true);
      let expanded = session.expand(result.handle!);

      // Load new content with different functions
      const newCode = `
function foo() { return 1; }
function bar() { return 2; }
function baz() { return 3; }
`.trim();

      await session.loadContentWithSymbols(newCode, "test.ts");
      result = session.execute('(list_symbols "function")');
      expect(result.success).toBe(true);
      expanded = session.expand(result.handle!);

      // Should have exactly 3 functions, not accumulated from previous load
      expect(expanded.data?.length).toBe(3);
      const names = (expanded.data as Array<{ name: string }>).map(s => s.name);
      expect(names).toContain("foo");
      expect(names).toContain("bar");
      expect(names).toContain("baz");
      expect(names).not.toContain("hello"); // Old function should be gone
    });
  });

  describe("symbol query operations", () => {
    beforeEach(async () => {
      await session.loadContentWithSymbols(sampleTypeScript, "test.ts");
    });

    it("should return handle for (list_symbols)", () => {
      const result = session.execute('(list_symbols)');
      expect(result.success).toBe(true);
      expect(result.handle).toMatch(/^\$res\d+$/);
      expect(result.stub).toBeDefined();
    });

    it("should allow expanding symbol handle", () => {
      const result = session.execute('(list_symbols "method")');
      expect(result.success).toBe(true);

      const expanded = session.expand(result.handle!, { limit: 2 });
      expect(expanded.success).toBe(true);
      expect(expanded.data?.length).toBeLessThanOrEqual(2);

      // Methods should have expected structure
      const symbols = expanded.data as Array<{ name: string; kind: string; startLine: number }>;
      symbols.forEach(sym => {
        expect(sym.kind).toBe("method");
        expect(typeof sym.startLine).toBe("number");
      });
    });

    it("should support get_symbol_body by name", () => {
      const result = session.execute('(get_symbol_body "hello")');
      expect(result.success).toBe(true);

      const body = result.value as string;
      expect(body).toContain("function hello");
      expect(body).toContain('return "Hello, "');
    });

    it("should support find_references", () => {
      const result = session.execute('(find_references "hello")');
      expect(result.success).toBe(true);
      expect(result.handle).toBeDefined();

      const expanded = session.expand(result.handle!);
      expect(expanded.data?.length).toBeGreaterThanOrEqual(2); // Declaration + usage
    });
  });

  describe("mixed grep + symbols workflow", () => {
    beforeEach(async () => {
      await session.loadContentWithSymbols(sampleTypeScript, "test.ts");
    });

    it("should support counting symbols", () => {
      const result = session.execute('(count (list_symbols "method"))');
      expect(result.success).toBe(true);
      expect(typeof result.value).toBe("number");
      expect(result.value).toBeGreaterThanOrEqual(2); // greet and farewell
    });

    it("should work with grep alongside symbols", () => {
      // Find all lines with "return"
      const grepResult = session.execute('(grep "return")');
      expect(grepResult.success).toBe(true);

      // Also list functions
      const symbolResult = session.execute('(list_symbols "function")');
      expect(symbolResult.success).toBe(true);

      // Both should work independently
      const grepExpanded = session.expand(grepResult.handle!);
      const symbolExpanded = session.expand(symbolResult.handle!);

      expect(grepExpanded.data?.length).toBeGreaterThan(0);
      expect(symbolExpanded.data?.length).toBeGreaterThan(0);
    });

    it("should support mapping symbol names", () => {
      // List all symbols
      const listResult = session.execute('(list_symbols)');
      expect(listResult.success).toBe(true);

      // Verify RESULTS contains symbols with name property
      const expanded = session.expand(listResult.handle!);
      expect(expanded.data?.length).toBeGreaterThan(0);

      // Each symbol should have the expected structure
      const symbols = expanded.data as Array<{ name: string; kind: string }>;
      symbols.forEach(s => {
        expect(typeof s.name).toBe("string");
        expect(typeof s.kind).toBe("string");
      });
    });
  });
});
