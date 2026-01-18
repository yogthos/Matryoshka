import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SessionDB } from "../../src/persistence/session-db.js";
import type { Symbol, SymbolKind } from "../../src/treesitter/types.js";

describe("SessionDB - Symbols", () => {
  let db: SessionDB;

  beforeEach(() => {
    db = new SessionDB();
  });

  afterEach(() => {
    db.close();
  });

  describe("table creation", () => {
    it("should create symbols table on init", () => {
      const tables = db.getTables();
      expect(tables).toContain("symbols");
    });
  });

  describe("symbol storage", () => {
    const sampleSymbol: Omit<Symbol, "id"> = {
      name: "testFunction",
      kind: "function",
      startLine: 10,
      endLine: 15,
      startCol: 0,
      endCol: 1,
      signature: "function testFunction(): void",
    };

    it("should store a symbol", () => {
      const id = db.storeSymbol(sampleSymbol);
      expect(id).toBeGreaterThan(0);
    });

    it("should retrieve a stored symbol by id", () => {
      const id = db.storeSymbol(sampleSymbol);
      const retrieved = db.getSymbol(id);

      expect(retrieved).not.toBeNull();
      expect(retrieved!.name).toBe("testFunction");
      expect(retrieved!.kind).toBe("function");
      expect(retrieved!.startLine).toBe(10);
      expect(retrieved!.endLine).toBe(15);
      expect(retrieved!.signature).toBe("function testFunction(): void");
    });

    it("should store nested symbol with parent reference", () => {
      // Store a class
      const classId = db.storeSymbol({
        name: "MyClass",
        kind: "class",
        startLine: 1,
        endLine: 20,
        startCol: 0,
        endCol: 1,
      });

      // Store a method inside the class
      const methodId = db.storeSymbol({
        name: "myMethod",
        kind: "method",
        startLine: 5,
        endLine: 10,
        startCol: 2,
        endCol: 3,
        parentSymbolId: classId,
      });

      const method = db.getSymbol(methodId);
      expect(method).not.toBeNull();
      expect(method!.parentSymbolId).toBe(classId);
    });

    it("should return null for non-existent symbol", () => {
      const retrieved = db.getSymbol(9999);
      expect(retrieved).toBeNull();
    });
  });

  describe("symbol retrieval", () => {
    beforeEach(() => {
      // Store multiple symbols
      db.storeSymbol({
        name: "func1",
        kind: "function",
        startLine: 1,
        endLine: 5,
        startCol: 0,
        endCol: 1,
      });
      db.storeSymbol({
        name: "func2",
        kind: "function",
        startLine: 10,
        endLine: 15,
        startCol: 0,
        endCol: 1,
      });
      db.storeSymbol({
        name: "MyClass",
        kind: "class",
        startLine: 20,
        endLine: 50,
        startCol: 0,
        endCol: 1,
      });
      db.storeSymbol({
        name: "MyInterface",
        kind: "interface",
        startLine: 55,
        endLine: 60,
        startCol: 0,
        endCol: 1,
      });
    });

    it("should retrieve all symbols", () => {
      const symbols = db.getAllSymbols();
      expect(symbols).toHaveLength(4);
    });

    it("should retrieve symbols by kind", () => {
      const functions = db.getSymbolsByKind("function");
      expect(functions).toHaveLength(2);
      expect(functions[0].name).toBe("func1");
      expect(functions[1].name).toBe("func2");
    });

    it("should retrieve symbol at specific line", () => {
      // Line 12 is inside func2 (10-15)
      const symbols = db.getSymbolsAtLine(12);
      expect(symbols).toHaveLength(1);
      expect(symbols[0].name).toBe("func2");
    });

    it("should return multiple symbols when line spans nested symbols", () => {
      // Add a method inside MyClass
      db.storeSymbol({
        name: "classMethod",
        kind: "method",
        startLine: 25,
        endLine: 30,
        startCol: 2,
        endCol: 3,
      });

      // Line 27 is inside both MyClass (20-50) and classMethod (25-30)
      const symbols = db.getSymbolsAtLine(27);
      expect(symbols.length).toBeGreaterThanOrEqual(2);
      const names = symbols.map((s) => s.name);
      expect(names).toContain("MyClass");
      expect(names).toContain("classMethod");
    });

    it("should find symbol by name", () => {
      const symbol = db.findSymbolByName("MyClass");
      expect(symbol).not.toBeNull();
      expect(symbol!.kind).toBe("class");
    });

    it("should return null when symbol not found by name", () => {
      const symbol = db.findSymbolByName("NonExistent");
      expect(symbol).toBeNull();
    });
  });

  describe("symbol clearing", () => {
    it("should clear symbols on clearSymbols", () => {
      db.storeSymbol({
        name: "func1",
        kind: "function",
        startLine: 1,
        endLine: 5,
        startCol: 0,
        endCol: 1,
      });

      expect(db.getAllSymbols()).toHaveLength(1);

      db.clearSymbols();

      expect(db.getAllSymbols()).toHaveLength(0);
    });

    it("should clear symbols when document is reloaded via clearAll", () => {
      db.storeSymbol({
        name: "func1",
        kind: "function",
        startLine: 1,
        endLine: 5,
        startCol: 0,
        endCol: 1,
      });

      db.clearAll();

      expect(db.getAllSymbols()).toHaveLength(0);
    });
  });

  describe("symbol kinds", () => {
    const allKinds: SymbolKind[] = [
      "function",
      "method",
      "class",
      "interface",
      "type",
      "struct",
      "variable",
      "constant",
      "property",
      "enum",
      "module",
      "namespace",
    ];

    it("should store and retrieve all symbol kinds", () => {
      for (const kind of allKinds) {
        db.storeSymbol({
          name: `symbol_${kind}`,
          kind,
          startLine: 1,
          endLine: 5,
          startCol: 0,
          endCol: 1,
        });
      }

      const symbols = db.getAllSymbols();
      expect(symbols).toHaveLength(allKinds.length);

      for (const kind of allKinds) {
        const byKind = db.getSymbolsByKind(kind);
        expect(byKind).toHaveLength(1);
        expect(byKind[0].name).toBe(`symbol_${kind}`);
      }
    });
  });
});
