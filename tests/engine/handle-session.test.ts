import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { HandleSession } from "../../src/engine/handle-session.js";

describe("HandleSession", () => {
  let session: HandleSession;

  const testDocument = `ERROR: Connection timeout at 10:00:00
INFO: Server started
ERROR: Database connection failed at 10:01:00
WARN: Memory usage high
ERROR: Request timeout at 10:02:00
INFO: Processing complete
DEBUG: Cache hit ratio: 95%`;

  beforeEach(() => {
    session = new HandleSession();
  });

  afterEach(() => {
    session.close();
  });

  describe("loadContent", () => {
    it("should load document and return stats", () => {
      const stats = session.loadContent(testDocument);

      expect(stats.lineCount).toBe(7);
      expect(stats.size).toBe(testDocument.length);
    });

    it("should mark session as loaded", () => {
      expect(session.isLoaded()).toBe(false);
      session.loadContent(testDocument);
      expect(session.isLoaded()).toBe(true);
    });
  });

  describe("execute - handle-based results", () => {
    beforeEach(() => {
      session.loadContent(testDocument);
    });

    it("should return handle stub for array results", () => {
      const result = session.execute('(grep "ERROR")');

      expect(result.success).toBe(true);
      expect(result.handle).toMatch(/^\$res\d+$/);
      expect(result.stub).toContain("Array(3)");
      expect(result.value).toBeUndefined(); // Full data not returned
    });

    it("should return scalar values directly", () => {
      // First get some results
      session.execute('(grep "ERROR")');

      // Then count them
      const result = session.execute("(count RESULTS)");

      expect(result.success).toBe(true);
      expect(result.value).toBe(3);
      expect(result.handle).toBeUndefined(); // No handle for scalars
    });

    it("should include preview in stub", () => {
      const result = session.execute('(grep "ERROR")');

      expect(result.stub).toContain("ERROR"); // Preview should show first item
    });

    it("should chain queries using RESULTS", () => {
      // Get all errors
      const grep = session.execute('(grep "ERROR")');
      expect(grep.success).toBe(true);

      // Filter to timeout errors - note: lambda syntax is (lambda x ...) not (lambda (x) ...)
      const filtered = session.execute(
        '(filter RESULTS (lambda x (match x "timeout" 0)))'
      );
      expect(filtered.success).toBe(true);
      expect(filtered.handle).toBeDefined();

      // Count filtered results
      const count = session.execute("(count RESULTS)");
      expect(count.value).toBe(2); // "Connection timeout" and "Request timeout"
    });
  });

  describe("expand - get full data when needed", () => {
    beforeEach(() => {
      session.loadContent(testDocument);
    });

    it("should expand handle to full data", () => {
      const grep = session.execute('(grep "ERROR")');
      const expanded = session.expand(grep.handle!);

      expect(expanded.success).toBe(true);
      expect(expanded.data).toHaveLength(3);
      expect(expanded.total).toBe(3);
    });

    it("should support limit for partial expansion", () => {
      const grep = session.execute('(grep "ERROR")');
      const expanded = session.expand(grep.handle!, { limit: 2 });

      expect(expanded.success).toBe(true);
      expect(expanded.data).toHaveLength(2);
      expect(expanded.total).toBe(3);
      expect(expanded.limit).toBe(2);
    });

    it("should support offset for pagination", () => {
      const grep = session.execute('(grep "ERROR")');
      const expanded = session.expand(grep.handle!, { offset: 1, limit: 2 });

      expect(expanded.success).toBe(true);
      expect(expanded.data).toHaveLength(2);
      expect(expanded.offset).toBe(1);
    });

    it("should format as lines when requested", () => {
      const grep = session.execute('(grep "ERROR")');
      const expanded = session.expand(grep.handle!, { format: "lines" });

      expect(expanded.success).toBe(true);
      // Lines format should include line numbers
      expect(expanded.data![0]).toMatch(/^\[\d+\]/);
    });

    it("should return error for invalid handle", () => {
      const expanded = session.expand("$invalid");

      expect(expanded.success).toBe(false);
      expect(expanded.error).toContain("Invalid handle");
    });
  });

  describe("getBindings - handle stubs for context", () => {
    beforeEach(() => {
      session.loadContent(testDocument);
    });

    it("should list all handles as stubs", () => {
      session.execute('(grep "ERROR")');
      session.execute('(grep "INFO")');

      const bindings = session.getBindings();

      expect(Object.keys(bindings)).toContain("$res1");
      expect(Object.keys(bindings)).toContain("$res2");
      expect(bindings["$res1"]).toContain("Array");
    });

    it("should indicate current RESULTS binding", () => {
      session.execute('(grep "ERROR")');

      const bindings = session.getBindings();

      expect(bindings["RESULTS"]).toContain("$res1");
    });
  });

  describe("preview and sample", () => {
    beforeEach(() => {
      session.loadContent(testDocument);
      // Use a pattern that matches all lines (any character sequence)
      session.execute('(grep "[A-Z]")'); // Matches all lines starting with letters
    });

    it("should preview first N items", () => {
      const bindings = session.getBindings();
      const handle = Object.keys(bindings).find((k) => k.startsWith("$res"))!;

      const preview = session.preview(handle, 3);

      expect(preview).toHaveLength(3);
    });

    it("should sample random N items", () => {
      const bindings = session.getBindings();
      const handle = Object.keys(bindings).find((k) => k.startsWith("$res"))!;

      const sample = session.sample(handle, 3);

      expect(sample).toHaveLength(3);
    });
  });

  describe("describe", () => {
    beforeEach(() => {
      session.loadContent(testDocument);
    });

    it("should describe handle contents", () => {
      const grep = session.execute('(grep "ERROR")');
      const desc = session.describe(grep.handle!);

      expect(desc.count).toBe(3);
      expect(desc.fields).toContain("line");
      expect(desc.fields).toContain("lineNum");
      expect(desc.sample).toHaveLength(3); // Shows up to 3 samples
    });
  });

  describe("reset", () => {
    beforeEach(() => {
      session.loadContent(testDocument);
    });

    it("should clear all handles but keep document", () => {
      session.execute('(grep "ERROR")');
      expect(Object.keys(session.getBindings()).length).toBeGreaterThan(0);

      session.reset();

      expect(Object.keys(session.getBindings()).length).toBe(0);
      expect(session.isLoaded()).toBe(true);
    });
  });

  describe("getSessionInfo", () => {
    it("should return session metadata", () => {
      session.loadContent(testDocument, "test.log");
      session.execute('(grep "ERROR")');

      const info = session.getSessionInfo();

      expect(info.documentPath).toBe("test.log");
      expect(info.documentSize).toBe(testDocument.length);
      expect(info.loadedAt).toBeInstanceOf(Date);
      expect(info.queryCount).toBe(1);
      expect(info.handleCount).toBe(1);
    });
  });
});

describe("HandleSession - Token Savings", () => {
  it("should demonstrate token savings with large results", () => {
    const session = new HandleSession();

    // Generate a large document
    const lines: string[] = [];
    for (let i = 0; i < 1000; i++) {
      lines.push(`[${i.toString().padStart(4, "0")}] Log entry with some data: value=${i * 100}`);
    }
    const largeDoc = lines.join("\n");

    session.loadContent(largeDoc);

    // Execute query that returns many results
    const result = session.execute('(grep "Log entry")');

    // Handle stub should be compact
    expect(result.stub!.length).toBeLessThan(100);

    // But full data is available via expand
    const expanded = session.expand(result.handle!);
    expect(expanded.data).toHaveLength(1000);

    // Calculate approximate token savings
    const stubTokens = Math.ceil(result.stub!.length / 4);
    const fullDataTokens = Math.ceil(JSON.stringify(expanded.data).length / 4);
    const savings = ((fullDataTokens - stubTokens) / fullDataTokens) * 100;

    expect(savings).toBeGreaterThan(95); // Should save 95%+ tokens

    session.close();
  });
});
