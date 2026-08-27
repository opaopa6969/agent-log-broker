/**
 * File Watcher Adapter
 *
 * Watches ~/.claude/projects/ for JSONL log files.
 * Agent-agnostic: does not require any changes to agents (BRK-AGENT-AGNOSTIC).
 *
 * Adapter contract:
 *   - discoverSessions(): find active sessions
 *   - watchSession(path): tail JSONL and emit parsed lines
 *
 * Future adapters: codex, gemini, windsurf, aider, etc.
 */

import { watch, type FSWatcher } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export interface DiscoveredSession {
  sessionId: string;
  sessionPath: string;
  projectPath: string;
  agentType: string;
}

export interface FileWatcherOptions {
  /** Base path to scan for Claude projects. Defaults to ~/.claude/projects */
  basePath?: string;
  /** Auto-discover interval in seconds */
  scanIntervalSeconds?: number;
}

export class FileWatcher {
  private basePath: string;
  private watchers = new Map<string, FSWatcher>();
  private offsets = new Map<string, number>();
  private scanIntervalSeconds: number;

  constructor(options: FileWatcherOptions = {}) {
    this.basePath =
      options.basePath ?? join(homedir(), ".claude", "projects");
    this.scanIntervalSeconds = options.scanIntervalSeconds ?? 30;
  }

  /**
   * Discover active sessions under the base path.
   * Scans for JSONL log files in session directories.
   */
  async discoverSessions(): Promise<DiscoveredSession[]> {
    const sessions: DiscoveredSession[] = [];

    try {
      const projectHashes = await readdir(this.basePath);

      for (const hash of projectHashes) {
        const sessionsDir = join(this.basePath, hash, "sessions");
        try {
          const sessionIds = await readdir(sessionsDir);
          for (const sessionId of sessionIds) {
            const logPath = join(sessionsDir, sessionId, "log.jsonl");
            try {
              await stat(logPath);
              sessions.push({
                sessionId,
                sessionPath: logPath,
                projectPath: hash, // Resolved via symlink in real impl
                agentType: "claude",
              });
            } catch (error) {
              console.warn(
                `[FileWatcher] Failed to inspect log file: ${logPath}`,
                error
              );
            }
          }
        } catch (error) {
          console.warn(
            `[FileWatcher] Failed to scan sessions directory: ${sessionsDir}`,
            error
          );
        }
      }
    } catch (error) {
      console.warn(
        `[FileWatcher] Failed to scan base path: ${this.basePath}`,
        error
      );
    }

    return sessions;
  }

  /**
   * Start watching a specific log file for new lines.
   * Emits parsed JSONL lines via the callback.
   */
  watchSession(
    sessionPath: string,
    onLine: (line: string, offset: number) => void
  ): void {
    if (this.watchers.has(sessionPath)) return;

    const watcher = watch(sessionPath, async () => {
      await this.readNewLines(sessionPath, onLine);
    });

    this.watchers.set(sessionPath, watcher);
    this.offsets.set(sessionPath, 0);
  }

  /**
   * Stop watching a session.
   */
  unwatchSession(sessionPath: string): void {
    const watcher = this.watchers.get(sessionPath);
    if (watcher) {
      watcher.close();
      this.watchers.delete(sessionPath);
    }
  }

  /**
   * Stop all watchers.
   */
  close(): void {
    for (const [path, watcher] of this.watchers) {
      watcher.close();
      this.watchers.delete(path);
    }
  }

  /**
   * Read new lines since last offset.
   *
   * The tracked offset is a **byte** offset into the file (not a JS string /
   * UTF-16 code-unit index). This matters because the log lines routinely
   * contain multibyte characters (Japanese agent logs, emoji, etc.): a single
   * character can span several bytes, so a character index and a byte index
   * diverge as soon as any non-ASCII content appears. Mixing the two units
   * caused the offset to run ahead of the real file position and slice
   * subsequent reads mid-line, dropping or corrupting log lines.
   *
   * To stay consistent we read the file as a raw Buffer, slice it by byte
   * offset, and locate line boundaries by scanning for the newline byte
   * (0x0A). Every advance is measured in bytes, matching the emitted offset.
   */
  private async readNewLines(
    sessionPath: string,
    onLine: (line: string, offset: number) => void
  ): Promise<void> {
    const currentOffset = this.offsets.get(sessionPath) ?? 0;

    try {
      const buffer = await readFile(sessionPath); // Buffer (no encoding)

      // Nothing new (also guards against truncation/rotation resetting size).
      if (currentOffset >= buffer.length) return;

      // Emit only complete, newline-terminated lines. A trailing partial line
      // (a log entry still being written) is left in place and picked up on
      // the next read once its newline arrives. All offsets are byte offsets.
      let lineStart = currentOffset;
      let newlineIndex = buffer.indexOf(0x0a, lineStart);

      while (newlineIndex !== -1) {
        const line = buffer.toString("utf-8", lineStart, newlineIndex);
        if (line.trim().length > 0) {
          onLine(line, lineStart);
        }
        lineStart = newlineIndex + 1; // advance past the newline byte
        newlineIndex = buffer.indexOf(0x0a, lineStart);
      }

      this.offsets.set(sessionPath, lineStart);
    } catch (error) {
      console.warn(
        `[FileWatcher] Failed to read watched file: ${sessionPath}`,
        error
      );
    }
  }
}
