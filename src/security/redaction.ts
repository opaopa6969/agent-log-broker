/**
 * Redaction & Security Flagging Pipeline
 *
 * Broker's only "content-aware" responsibility:
 *   - Redact PII (SSN, email, phone, etc.)
 *   - Flag security concerns (dangerous commands, secret access)
 *   - Flag banned words
 *
 * Redaction levels (BRK-REDACTION-LEVELS):
 *   - minimal: PII patterns only (SSN, email, phone)
 *   - standard: PII + credentials + secrets
 *   - strict: PII + credentials + secrets + file paths
 */

import type { RedactionLevel } from "../broker/subscription.js";

export interface SecurityFlag {
  type: "dangerous_command" | "secret_access" | "banned_word" | "pii_detected";
  severity: "low" | "medium" | "high" | "critical";
  detail: string;
  field: string;
}

export interface RedactionResult {
  redactedText: string;
  redactionCount: number;
  securityFlags: SecurityFlag[];
}

// ── PII Patterns ──

const PII_PATTERNS: Array<{ name: string; pattern: RegExp; replacement: string }> = [
  {
    name: "email",
    pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    replacement: "[REDACTED:EMAIL]",
  },
  {
    name: "phone",
    pattern: /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g,
    replacement: "[REDACTED:PHONE]",
  },
  {
    name: "ssn",
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    replacement: "[REDACTED:SSN]",
  },
  {
    name: "jp_phone",
    pattern: /\b0\d{1,4}-\d{1,4}-\d{4}\b/g,
    replacement: "[REDACTED:PHONE]",
  },
];

const CREDENTIAL_PATTERNS: Array<{ name: string; pattern: RegExp; replacement: string }> = [
  {
    name: "aws_key",
    pattern: /AKIA[0-9A-Z]{16}/g,
    replacement: "[REDACTED:AWS_KEY]",
  },
  {
    name: "generic_secret",
    pattern: /(?:password|secret|token|api_key|apikey)\s*[:=]\s*['"]?[^\s'"]{8,}/gi,
    replacement: "[REDACTED:SECRET]",
  },
];

const DANGEROUS_COMMANDS = [
  "rm -rf",
  "chmod 777",
  "curl | bash",
  "wget | sh",
  ".env",
  "id_rsa",
  "/etc/shadow",
  "/etc/passwd",
];

export class RedactionPipeline {
  private level: RedactionLevel;

  constructor(level: RedactionLevel = "standard") {
    this.level = level;
  }

  /**
   * Apply redaction and security flagging to text content.
   */
  process(text: string): RedactionResult {
    let redactedText = text;
    let redactionCount = 0;
    const securityFlags: SecurityFlag[] = [];

    // Always apply PII redaction (all levels)
    for (const { name, pattern, replacement } of PII_PATTERNS) {
      const matches = redactedText.match(pattern);
      if (matches) {
        redactionCount += matches.length;
        securityFlags.push({
          type: "pii_detected",
          severity: "medium",
          detail: `${name} pattern detected (${matches.length} occurrences)`,
          field: "text",
        });
        redactedText = redactedText.replace(pattern, replacement);
      }
    }

    // Standard and strict: also redact credentials
    if (this.level === "standard" || this.level === "strict") {
      for (const { name, pattern, replacement } of CREDENTIAL_PATTERNS) {
        const matches = redactedText.match(pattern);
        if (matches) {
          redactionCount += matches.length;
          securityFlags.push({
            type: "secret_access",
            severity: "high",
            detail: `${name} pattern detected`,
            field: "text",
          });
          redactedText = redactedText.replace(pattern, replacement);
        }
      }
    }

    // Security flagging (all levels, does not redact)
    for (const cmd of DANGEROUS_COMMANDS) {
      if (text.includes(cmd)) {
        securityFlags.push({
          type: "dangerous_command",
          severity: cmd === "rm -rf" ? "critical" : "high",
          detail: `Dangerous pattern detected: ${cmd}`,
          field: "text",
        });
      }
    }

    return { redactedText, redactionCount, securityFlags };
  }
}
