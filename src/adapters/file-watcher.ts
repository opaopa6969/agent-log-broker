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
            } catch {
              // log.jsonl doesn't exist, skip
            }
          }
        } catch {
          // No sessions dir, skip
        }
      }
    } catch {
      // Base path doesn't exist yet
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

  /** Read new lines since last offset */
  private async readNewLines(
    sessionPath: string,
    onLine: (line: string, offset: number) => void
  ): Promise<void> {
    const currentOffset = this.offsets.get(sessionPath) ?? 0;

    try {
      const content = await readFile(sessionPath, "utf-8");
      const newContent = content.slice(currentOffset);

      if (newContent.length === 0) return;

      const lines = newContent.split("\n").filter((l) => l.trim().length > 0);
      let offset = currentOffset;

      for (const line of lines) {
        onLine(line, offset);
        offset += Buffer.byteLength(line, "utf-8") + 1; // +1 for newline
      }

      this.offsets.set(sessionPath, offset);
    } catch {
      // File may have been deleted/moved
    }
  }
}
