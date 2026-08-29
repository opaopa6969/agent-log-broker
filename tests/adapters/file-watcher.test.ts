import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, appendFile, rm, mkdir, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { FileWatcher } from "../../src/adapters/file-watcher.js";

/**
 * These tests pin down the byte-offset tracking in FileWatcher.readNewLines().
 *
 * Regression target: the offset used to be advanced by Buffer.byteLength(line)
 * (bytes) while the slice that produced new content used a string/UTF-16 index
 * (characters). For ASCII-only logs the two units coincide and the bug is
 * invisible, but agent logs routinely contain Japanese text and emoji, where a
 * character spans multiple bytes. Once a multibyte line was read, the offset
 * ran ahead of the real character position and later reads sliced mid-line,
 * dropping or corrupting subsequent log lines.
 */

// readNewLines is private; access it through a typed structural cast so the
// test drives the exact code path fs.watch would trigger, but deterministically.
type ReadNewLines = (
  sessionPath: string,
  onLine: (line: string, offset: number) => void
) => Promise<void>;

function readNewLines(watcher: FileWatcher): ReadNewLines {
  return (watcher as unknown as { readNewLines: ReadNewLines }).readNewLines.bind(
    watcher
  );
}

describe("FileWatcher.readNewLines byte-offset tracking", () => {
  let dir: string;
  let logPath: string;
  let watcher: FileWatcher;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "alb-watcher-"));
    logPath = join(dir, "log.jsonl");
    watcher = new FileWatcher();
  });

  afterEach(async () => {
    watcher.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("reads incrementally appended multibyte (Japanese) JSONL one line at a time", async () => {
    const read = readNewLines(watcher);

    // Batch 1: two Japanese log entries.
    const batch1 = [
      { role: "user", text: "こんにちは、エージェントさん" },
      { role: "assistant", text: "了解しました。処理を開始します。" },
    ];
    await writeFile(
      logPath,
      batch1.map((o) => JSON.stringify(o)).join("\n") + "\n",
      "utf-8"
    );

    const seen1: string[] = [];
    await read(logPath, (line) => seen1.push(line));

    expect(seen1).toHaveLength(2);
    // Each emitted line must be intact, parseable, and equal to the original.
    expect(JSON.parse(seen1[0])).toEqual(batch1[0]);
    expect(JSON.parse(seen1[1])).toEqual(batch1[1]);

    // Batch 2: append two more entries (mixing emoji + Japanese + ASCII).
    const batch2 = [
      { role: "user", text: "ログを確認して 🙏 status=OK" },
      { role: "assistant", text: "全ての行が壊れずに読めています。🎉" },
    ];
    await appendFile(
      logPath,
      batch2.map((o) => JSON.stringify(o)).join("\n") + "\n",
      "utf-8"
    );

    const seen2: string[] = [];
    await read(logPath, (line) => seen2.push(line));

    // Only the two NEW lines, intact — no re-emission and no corruption of the
    // boundary between the multibyte batches. Under the old byte/char mismatch
    // these would be truncated or lost.
    expect(seen2).toHaveLength(2);
    expect(JSON.parse(seen2[0])).toEqual(batch2[0]);
    expect(JSON.parse(seen2[1])).toEqual(batch2[1]);
  });

  it("emits offsets that are true byte positions of each line", async () => {
    const read = readNewLines(watcher);

    const lines = [
      JSON.stringify({ i: 0, t: "日本語" }), // multibyte
      JSON.stringify({ i: 1, t: "ascii" }),
      JSON.stringify({ i: 2, t: "絵文字🎉テスト" }),
    ];
    await writeFile(logPath, lines.join("\n") + "\n", "utf-8");

    const offsets: number[] = [];
    const emitted: string[] = [];
    await read(logPath, (line, offset) => {
      emitted.push(line);
      offsets.push(offset);
    });

    expect(emitted).toEqual(lines);

    // Expected byte offset of each line = cumulative byte length of all prior
    // lines plus their newline bytes.
    let expected = 0;
    for (let i = 0; i < lines.length; i++) {
      expect(offsets[i]).toBe(expected);
      expected += Buffer.byteLength(lines[i], "utf-8") + 1; // +1 for "\n"
    }
  });

  it("holds a trailing partial line until its newline arrives", async () => {
    const read = readNewLines(watcher);

    // Write a complete line plus a partial (un-terminated) multibyte line.
    const complete = JSON.stringify({ n: 1, t: "完了行" });
    const partial = JSON.stringify({ n: 2, t: "書きかけの行" });
    await writeFile(logPath, complete + "\n" + partial, "utf-8");

    const first: string[] = [];
    await read(logPath, (line) => first.push(line));
    // Only the complete line is emitted; the partial one is withheld.
    expect(first).toHaveLength(1);
    expect(JSON.parse(first[0])).toEqual({ n: 1, t: "完了行" });

    // Now the partial line's newline arrives.
    await appendFile(logPath, "\n", "utf-8");

    const second: string[] = [];
    await read(logPath, (line) => second.push(line));
    expect(second).toHaveLength(1);
    expect(JSON.parse(second[0])).toEqual({ n: 2, t: "書きかけの行" });
  });

  it("keeps byte accounting correct across blank lines", async () => {
    const read = readNewLines(watcher);

    // Blank line between two multibyte entries must not desync the offset.
    const a = JSON.stringify({ x: "先頭" });
    const b = JSON.stringify({ x: "末尾" });
    await writeFile(logPath, a + "\n\n" + b + "\n", "utf-8");

    const seen: string[] = [];
    await read(logPath, (line) => seen.push(line));

    // Blank line is skipped from emission but its byte is still accounted for.
    expect(seen).toEqual([a, b]);

    // A subsequent append must be read cleanly (proves offset landed exactly
    // at end-of-file, not short by the blank line's byte).
    const c = JSON.stringify({ x: "追記" });
    await appendFile(logPath, c + "\n", "utf-8");

    const seen2: string[] = [];
    await read(logPath, (line) => seen2.push(line));
    expect(seen2).toEqual([c]);
  });

  it("reads new content after file truncation (offset resets to 0)", async () => {
    const read = readNewLines(watcher);

    // 1. Write two lines and read them.
    const batch1 = [
      JSON.stringify({ a: 1 }),
      JSON.stringify({ b: 2 }),
    ];
    await writeFile(
      logPath,
      batch1.map((o) => o).join("\n") + "\n",
      "utf-8"
    );

    const seen1: string[] = [];
    await read(logPath, (line) => seen1.push(line));
    expect(seen1).toEqual(batch1);

    // 2. Truncate the file to 0 bytes, then write new content.
    await truncate(logPath, 0);
    const newLine = JSON.stringify({ c: 3 });
    await writeFile(logPath, newLine + "\n", "utf-8");

    // 3. Re-read — should get the new content (not an empty array).
    const seen2: string[] = [];
    await read(logPath, (line) => seen2.push(line));
    expect(seen2).toEqual([newLine]);
  });

  it("reads new content after truncation with multibyte (Japanese) lines", async () => {
    const read = readNewLines(watcher);

    // Initial content with Japanese text (longer than post-truncation content).
    const initial = JSON.stringify({ msg: "初期状態の長いログメッセージ" });
    await writeFile(logPath, initial + "\n", "utf-8");

    const seen1: string[] = [];
    await read(logPath, (line) => seen1.push(line));
    expect(seen1).toEqual([initial]);

    // Truncate and write shorter Japanese content. The file is now smaller
    // than the previous offset, so truncation is detected and offset resets.
    await truncate(logPath, 0);
    const after = JSON.stringify({ msg: "新ログ" });
    await writeFile(logPath, after + "\n", "utf-8");

    const seen2: string[] = [];
    await read(logPath, (line) => seen2.push(line));
    expect(seen2).toEqual([after]);
  });
});

/**
 * Coverage for discoverSessions / watchSession / unwatchSession / close.
 *
 * fs.watch is a real Node event source, so these tests drive it against a tmp
 * directory with actual files. A short await + append cycle is used to let the
 * watcher's async callback fire; we never assert on fs.watch internals.
 */
describe("FileWatcher.discoverSessions / watch / close", () => {
  let baseDir: string;
  let watcher: FileWatcher;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "alb-discover-"));
    watcher = new FileWatcher({ basePath: baseDir });
  });

  afterEach(async () => {
    watcher.close();
    await rm(baseDir, { recursive: true, force: true });
  });

  // ── discoverSessions ──

  describe("discoverSessions()", () => {
    it("returns an empty array when basePath does not exist", async () => {
      const w = new FileWatcher({
        basePath: join(baseDir, "does-not-exist"),
      });
      const sessions = await w.discoverSessions();
      expect(sessions).toEqual([]);
    });

    it("returns an empty array when basePath is empty", async () => {
      const sessions = await watcher.discoverSessions();
      expect(sessions).toEqual([]);
    });

    it("discovers sessions whose log.jsonl exists and returns their paths", async () => {
      // Structure: <base>/<hash>/sessions/<sessionId>/log.jsonl
      const hash = "project-hash-1";
      const sessionId = "session-abc";
      const sessionsDir = join(baseDir, hash, "sessions", sessionId);
      await mkdir(sessionsDir, { recursive: true });
      const logPath = join(sessionsDir, "log.jsonl");
      await writeFile(logPath, '{"role":"user","text":"hi"}\n', "utf-8");

      const sessions = await watcher.discoverSessions();

      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toEqual({
        sessionId,
        sessionPath: logPath,
        // projectPath is the raw hash today (symlink resolution is Phase 2).
        projectPath: hash,
        agentType: "claude",
      });
    });

    it("skips session directories that have no log.jsonl", async () => {
      const hash = "project-hash-1";
      const withLog = "session-with-log";
      const withoutLog = "session-without-log";
      await mkdir(join(baseDir, hash, "sessions", withLog), {
        recursive: true,
      });
      await writeFile(
        join(baseDir, hash, "sessions", withLog, "log.jsonl"),
        '{"role":"user"}\n',
        "utf-8"
      );
      await mkdir(join(baseDir, hash, "sessions", withoutLog), {
        recursive: true,
      });
      // No log.jsonl under withoutLog.

      const sessions = await watcher.discoverSessions();

      expect(sessions).toHaveLength(1);
      expect(sessions[0].sessionId).toBe(withLog);
    });

    it("skips project hashes that have no sessions directory", async () => {
      const hashWith = "has-sessions";
      const hashWithout = "no-sessions";
      await mkdir(join(baseDir, hashWith, "sessions", "s1"), {
        recursive: true,
      });
      await writeFile(
        join(baseDir, hashWith, "sessions", "s1", "log.jsonl"),
        '{"role":"user"}\n',
        "utf-8"
      );
      // hashWithout has no sessions/ dir at all.
      await mkdir(join(baseDir, hashWithout), { recursive: true });

      const sessions = await watcher.discoverSessions();

      expect(sessions).toHaveLength(1);
      expect(sessions[0].sessionId).toBe("s1");
    });

    it("discovers multiple sessions across multiple project hashes", async () => {
      const setups = [
        ["hash-a", "s-a1"],
        ["hash-a", "s-a2"],
        ["hash-b", "s-b1"],
      ] as const;
      for (const [hash, sid] of setups) {
        const dir = join(baseDir, hash, "sessions", sid);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "log.jsonl"), "{}\n", "utf-8");
      }

      const sessions = await watcher.discoverSessions();
      const ids = sessions.map((s) => s.sessionId).sort();
      expect(ids).toEqual(["s-a1", "s-a2", "s-b1"]);
    });
  });

  // ── watchSession ──

  describe("watchSession()", () => {
    it("begins tracking offset at 0 for a new path", async () => {
      const logPath = join(baseDir, "watched.log");
      await writeFile(logPath, '{"role":"user","text":"first"}\n', "utf-8");

      // watchSession should not throw and should register the path.
      expect(() =>
        watcher.watchSession(logPath, () => {})
      ).not.toThrow();

      // The internal offset map should now have an entry at 0 (readNewLines
      // starts from byte 0 on the first fs.watch callback).
      const offsets = (watcher as unknown as { offsets: Map<string, number> })
        .offsets;
      expect(offsets.get(logPath)).toBe(0);
    });

    it("emits file content on fs.watch callback (offset starts at 0)", async () => {
      const logPath = join(baseDir, "initial.log");
      await writeFile(logPath, '{"role":"user","text":"first"}\n', "utf-8");

      const seen: string[] = [];
      watcher.watchSession(logPath, (line) => {
        seen.push(line);
      });

      // fs.watch may fire on registration or on the next change. Trigger a
      // no-op touch by appending a newline so a callback is guaranteed.
      await appendFile(logPath, "\n", "utf-8");
      await sleep(200);

      // The original line must have been emitted at least once. (We do not
      // assert the empty appended line: it is filtered out by readNewLines.)
      expect(seen).toContain('{"role":"user","text":"first"}');
    });

    it("is idempotent — re-registering the same path is a no-op (no reset, no duplicate watcher)", async () => {
      const logPath = join(baseDir, "idempotent.log");
      await writeFile(logPath, '{"i":0}\n', "utf-8");

      const onLine = (line: string) => {
        // no-op
      };
      watcher.watchSession(logPath, onLine);

      // Capture the original watcher handle.
      const watchers = (watcher as unknown as { watchers: Map<string, unknown> })
        .watchers;
      const original = watchers.get(logPath);

      // Re-register the same path: should be a no-op.
      watcher.watchSession(logPath, onLine);

      // The same watcher handle is retained (not replaced).
      expect(watchers.get(logPath)).toBe(original);
      expect(watchers.size).toBe(1);
    });
  });

  // ── unwatchSession ──

  describe("unwatchSession()", () => {
    it("is a no-op for a path that was never watched (does not throw)", () => {
      expect(() =>
        watcher.unwatchSession(join(baseDir, "never-watched.log"))
      ).not.toThrow();
    });

    it("removes the watcher from the internal map for a registered path", async () => {
      const logPath = join(baseDir, "unwatch.log");
      await writeFile(logPath, '{"i":0}\n', "utf-8");

      watcher.watchSession(logPath, () => {});

      const watchers = (watcher as unknown as { watchers: Map<string, unknown> })
        .watchers;
      expect(watchers.has(logPath)).toBe(true);

      watcher.unwatchSession(logPath);

      expect(watchers.has(logPath)).toBe(false);
    });
  });

  // ── close ──

  describe("close()", () => {
    it("clears all registered watchers from the internal map", async () => {
      const a = join(baseDir, "a.log");
      const b = join(baseDir, "b.log");
      await writeFile(a, '{"i":0}\n', "utf-8");
      await writeFile(b, '{"i":0}\n', "utf-8");

      watcher.watchSession(a, () => {});
      watcher.watchSession(b, () => {});

      const watchers = (watcher as unknown as { watchers: Map<string, unknown> })
        .watchers;
      expect(watchers.size).toBe(2);

      watcher.close();

      expect(watchers.size).toBe(0);
    });

    it("is safe to call when no watchers are registered", () => {
      expect(() => watcher.close()).not.toThrow();
    });
  });
});
