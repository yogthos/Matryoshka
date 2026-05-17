/**
 * Tests for lattice-mcp process lifecycle: --version / --help flags and
 * graceful shutdown on stdin EOF.
 *
 * Background: long-lived lattice-mcp processes were piling up in `ps`
 * because StdioServerTransport never listens for stdin `end`/`close`. When
 * the MCP client closed its end of the pipe (or its terminal died without
 * sending SIGTERM), nothing told the server to exit. These tests pin the
 * fix: any of the disconnect paths produces a clean exit within ~2s.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { spawn, execSync } from "node:child_process";
import { resolve } from "node:path";
import { existsSync, readFileSync, statSync, symlinkSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SERVER_ENTRY = resolve(REPO_ROOT, "src/lattice-mcp-server.ts");
const SERVER_DIST = resolve(REPO_ROOT, "dist/lattice-mcp-server.js");
// CLI-flag tests use tsx (fast, no build needed). Lifecycle/signal tests
// invoke `node dist/...` directly because tsx wraps the user script in a
// parent Node process: SIGHUP/SIGTERM sent to the tsx wrapper kill the
// wrapper before propagating to the child, so the test would observe the
// wrapper's death-by-signal rather than the server's clean exit.
const TSX_BIN = resolve(REPO_ROOT, "node_modules/.bin/tsx");
const EXPECTED_VERSION = JSON.parse(
  readFileSync(resolve(REPO_ROOT, "package.json"), "utf-8")
).version as string;

// Ensure dist/lattice-mcp-server.js exists and is newer than its source.
// The shutdown tests spawn the built artifact (see comment above), so a
// missing or stale dist would either fail or silently exercise the wrong
// code. `tsc` is fast (~2s) — cheaper than maintaining a stale-detection
// dance.
function ensureDistBuilt(): void {
  const srcMtime = statSync(SERVER_ENTRY).mtimeMs;
  const distMtime = existsSync(SERVER_DIST) ? statSync(SERVER_DIST).mtimeMs : 0;
  if (distMtime < srcMtime) {
    execSync("pnpm build", { cwd: REPO_ROOT, stdio: "inherit" });
  }
}

// Vitest's default per-test timeout is fine; we cap subprocess waits well
// under it. 2000ms is generous — shutdown should fire on the next tick
// after EOF / signal.
const SHUTDOWN_WAIT_MS = 2000;

function runCli(args: string[]): { stdout: string; stderr: string; code: number } {
  try {
    const stdout = execSync(`${TSX_BIN} ${SERVER_ENTRY} ${args.join(" ")}`, {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      timeout: 15000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { stdout, stderr: "", code: 0 };
  } catch (e: unknown) {
    const err = e as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number };
    return {
      stdout: typeof err.stdout === "string" ? err.stdout : err.stdout?.toString() ?? "",
      stderr: typeof err.stderr === "string" ? err.stderr : err.stderr?.toString() ?? "",
      code: err.status ?? 1,
    };
  }
}

describe("lattice-mcp CLI flags", () => {
  it("--version prints version and exits 0", () => {
    const { stdout, code } = runCli(["--version"]);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe(`lattice-mcp v${EXPECTED_VERSION}`);
  });

  it("-v is an alias for --version", () => {
    const { stdout, code } = runCli(["-v"]);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe(`lattice-mcp v${EXPECTED_VERSION}`);
  });

  it("--help prints usage and exits 0", () => {
    const { stdout, code } = runCli(["--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("Usage: lattice-mcp");
    expect(stdout).toContain("--version");
    expect(stdout).toContain("--help");
    // Help should document the EOF/signal shutdown contract so a user
    // reading it understands the server isn't hung waiting on stdin.
    expect(stdout).toMatch(/EOF|SIGINT|SIGTERM|SIGHUP/);
  });

  it("-h is an alias for --help", () => {
    const { stdout, code } = runCli(["-h"]);
    expect(code).toBe(0);
    expect(stdout).toContain("Usage: lattice-mcp");
  });

  it("--version works when invoked through a symlink (npm-link case)", () => {
    // Regression test for the original bug: when the bin is reached via
    // an npm-link symlink, `argv[1]` keeps the symlinked path while
    // `import.meta.url` resolves through it — naive entry-point detection
    // would mismatch and `main()` would never run. Simulate by pointing a
    // temp symlink at the real entry file.
    const dir = mkdtempSync(join(tmpdir(), "lattice-symlink-"));
    const linkPath = join(dir, "lattice-mcp-server.ts");
    try {
      symlinkSync(SERVER_ENTRY, linkPath);
      const stdout = execSync(`${TSX_BIN} ${linkPath} --version`, {
        cwd: REPO_ROOT,
        encoding: "utf-8",
        timeout: 15000,
      });
      expect(stdout.trim()).toBe(`lattice-mcp v${EXPECTED_VERSION}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("lattice-mcp shutdown lifecycle", () => {
  beforeAll(() => {
    ensureDistBuilt();
  }, 60000);

  /**
   * Spawn the server, wait for it to announce it has started, then run
   * `triggerShutdown` against the child. Returns the exit code and how
   * long the shutdown took. Times out if the process doesn't exit within
   * SHUTDOWN_WAIT_MS after the trigger.
   */
  async function spawnServerAndShutdown(
    triggerShutdown: (child: ReturnType<typeof spawn>) => void
  ): Promise<{ code: number | null; signal: NodeJS.Signals | null; elapsedMs: number }> {
    const child = spawn(process.execPath, [SERVER_DIST], {
      cwd: REPO_ROOT,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (!child.stdin || !child.stderr) {
      throw new Error("spawned child missing piped stdio");
    }
    const childStderr = child.stderr;

    let stderr = "";
    childStderr.on("data", (d) => (stderr += d.toString()));

    // Wait until the server logs that it has started. Using stderr because
    // the lattice server writes its startup banner to stderr (stdout is the
    // MCP message channel).
    await new Promise<void>((resolveReady, rejectReady) => {
      const onData = (d: Buffer) => {
        if (d.toString().includes("MCP server started")) {
          childStderr.off("data", onData);
          resolveReady();
        }
      };
      childStderr.on("data", onData);
      const startupTimer = setTimeout(() => {
        childStderr.off("data", onData);
        rejectReady(new Error(`server did not start within 10s.\nstderr:\n${stderr}`));
      }, 10000);
      child.on("exit", () => clearTimeout(startupTimer));
    });

    const startedAt = Date.now();
    triggerShutdown(child);

    return await new Promise((resolveExit, rejectExit) => {
      const exitTimer = setTimeout(() => {
        // Kill so we don't leak the process from the test suite.
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
        rejectExit(
          new Error(
            `process did not exit within ${SHUTDOWN_WAIT_MS}ms.\nstderr:\n${stderr}`
          )
        );
      }, SHUTDOWN_WAIT_MS);

      child.on("exit", (code, signal) => {
        clearTimeout(exitTimer);
        resolveExit({ code, signal, elapsedMs: Date.now() - startedAt });
      });
    });
  }

  it("exits cleanly when stdin is closed (the zombie-process root cause)", async () => {
    const result = await spawnServerAndShutdown((child) => {
      // Close our write end of the pipe — the child sees stdin EOF.
      child.stdin?.end();
    });
    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    // Should be near-instant — failure mode is "never exits".
    expect(result.elapsedMs).toBeLessThan(SHUTDOWN_WAIT_MS);
  });

  it("exits cleanly on SIGTERM", async () => {
    const result = await spawnServerAndShutdown((child) => {
      child.kill("SIGTERM");
    });
    expect(result.code).toBe(0);
  });

  it("exits cleanly on SIGHUP (terminal closure)", async () => {
    // SIGHUP is the new handler — added because terminal teardown
    // delivers SIGHUP, not SIGTERM, and the old code ignored it.
    const result = await spawnServerAndShutdown((child) => {
      child.kill("SIGHUP");
    });
    expect(result.code).toBe(0);
  });
});
