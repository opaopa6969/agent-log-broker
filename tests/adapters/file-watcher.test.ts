import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
});
