import { describe, it, expect } from "vitest";
import { RedactionPipeline } from "../../src/security/redaction.js";

describe("RedactionPipeline", () => {
  describe("PII patterns (all levels)", () => {
    it("redacts email addresses", () => {
      const pipeline = new RedactionPipeline("minimal");
      const result = pipeline.process("Contact user@example.com for support.");
      expect(result.redactedText).toBe("Contact [REDACTED:EMAIL] for support.");
      expect(result.redactionCount).toBe(1);
    });

    it("redacts US phone numbers (dash format)", () => {
      const pipeline = new RedactionPipeline("minimal");
      const result = pipeline.process("Call me at 555-867-5309 anytime.");
      expect(result.redactedText).toBe("Call me at [REDACTED:PHONE] anytime.");
      expect(result.redactionCount).toBe(1);
    });

    it("redacts Japanese phone numbers", () => {
      const pipeline = new RedactionPipeline("minimal");
      const result = pipeline.process("電話番号: 03-1234-5678");
      expect(result.redactedText).toBe("電話番号: [REDACTED:PHONE]");
      expect(result.redactionCount).toBe(1);
    });

    it("redacts SSN patterns", () => {
      const pipeline = new RedactionPipeline("minimal");
      const result = pipeline.process("SSN: 123-45-6789");
      expect(result.redactedText).toBe("SSN: [REDACTED:SSN]");
      expect(result.redactionCount).toBe(1);
    });

    it("does not redact clean text", () => {
      const pipeline = new RedactionPipeline("minimal");
      const result = pipeline.process("Hello, world! This is a safe message.");
      expect(result.redactedText).toBe("Hello, world! This is a safe message.");
      expect(result.redactionCount).toBe(0);
      expect(result.securityFlags).toHaveLength(0);
    });

    it("counts multiple matches", () => {
      const pipeline = new RedactionPipeline("minimal");
      const result = pipeline.process(
        "Emails: alice@example.com and bob@test.org"
      );
      expect(result.redactionCount).toBe(2);
      expect(result.redactedText).toBe(
        "Emails: [REDACTED:EMAIL] and [REDACTED:EMAIL]"
      );
    });

    it("sets pii_detected flag", () => {
      const pipeline = new RedactionPipeline("minimal");
      const result = pipeline.process("user@example.com");
      const piiFlags = result.securityFlags.filter(
        (f) => f.type === "pii_detected"
      );
      expect(piiFlags.length).toBeGreaterThan(0);
      expect(piiFlags[0].severity).toBe("medium");
    });

    it("redacts multiple distinct PII types in a single text and aggregates counts + flags", () => {
      const pipeline = new RedactionPipeline("minimal");
      const text =
        "Email user@example.com, phone 555-867-5309, ssn 123-45-6789.";
      const result = pipeline.process(text);
      // Three distinct PII patterns, each matched once.
      expect(result.redactionCount).toBe(3);
      expect(result.redactedText).toBe(
        "Email [REDACTED:EMAIL], phone [REDACTED:PHONE], ssn [REDACTED:SSN]."
      );
      // One flag per PII pattern type that fired.
      const piiFlags = result.securityFlags.filter(
        (f) => f.type === "pii_detected"
      );
      expect(piiFlags).toHaveLength(3);
      const names = piiFlags.map((f) => f.detail).sort();
      expect(names).toEqual([
        "email pattern detected (1 occurrences)",
        "phone pattern detected (1 occurrences)",
        "ssn pattern detected (1 occurrences)",
      ]);
    });

    it("handles empty string input (boundary)", () => {
      const pipeline = new RedactionPipeline("standard");
      const result = pipeline.process("");
      expect(result.redactedText).toBe("");
      expect(result.redactionCount).toBe(0);
      expect(result.securityFlags).toHaveLength(0);
    });
  });

  describe("credential redaction (standard level)", () => {
    it("redacts AWS access keys", () => {
      const pipeline = new RedactionPipeline("standard");
      const result = pipeline.process("Key: AKIAIOSFODNN7EXAMPLE");
      expect(result.redactedText).toContain("[REDACTED:AWS_KEY]");
      expect(result.redactionCount).toBe(1);
    });

    it("redacts password= assignments", () => {
      const pipeline = new RedactionPipeline("standard");
      const result = pipeline.process("password=supersecret123");
      expect(result.redactedText).toContain("[REDACTED:SECRET]");
      expect(result.redactionCount).toBe(1);
    });

    it("sets secret_access flag", () => {
      const pipeline = new RedactionPipeline("standard");
      const result = pipeline.process("password=supersecret123");
      const secretFlags = result.securityFlags.filter(
        (f) => f.type === "secret_access"
      );
      expect(secretFlags.length).toBeGreaterThan(0);
      expect(secretFlags[0].severity).toBe("high");
    });
  });

  describe("minimal level skips credentials", () => {
    it("does NOT redact password at minimal level", () => {
      const pipeline = new RedactionPipeline("minimal");
      const result = pipeline.process("password=supersecret123");
      expect(result.redactedText).toBe("password=supersecret123");
      expect(result.redactionCount).toBe(0);
    });
  });

  describe("dangerous command flagging", () => {
    it("flags rm -rf as critical", () => {
      const pipeline = new RedactionPipeline("minimal");
      const result = pipeline.process("rm -rf /tmp/data");
      const dangerFlags = result.securityFlags.filter(
        (f) => f.type === "dangerous_command"
      );
      expect(dangerFlags.length).toBeGreaterThan(0);
      expect(dangerFlags[0].severity).toBe("critical");
    });

    it("flags .env access", () => {
      const pipeline = new RedactionPipeline("minimal");
      const result = pipeline.process("cat .env");
      const dangerFlags = result.securityFlags.filter(
        (f) => f.type === "dangerous_command"
      );
      expect(dangerFlags.length).toBeGreaterThan(0);
      expect(dangerFlags[0].severity).toBe("high");
    });

    it("does not flag safe commands", () => {
      const pipeline = new RedactionPipeline("minimal");
      const result = pipeline.process("ls -la /home/user");
      const dangerFlags = result.securityFlags.filter(
        (f) => f.type === "dangerous_command"
      );
      expect(dangerFlags).toHaveLength(0);
    });

    it("dangerous commands don't increment redactionCount (flagging only)", () => {
      const pipeline = new RedactionPipeline("minimal");
      const result = pipeline.process("rm -rf /important/data");
      // rm -rf is flagged but not replaced in text
      expect(result.redactionCount).toBe(0);
      expect(result.redactedText).toBe("rm -rf /important/data");
    });
  });

  describe("dangerous command substring false-positive prevention", () => {
    it("does NOT flag .environment (substring of .env)", () => {
      const pipeline = new RedactionPipeline("minimal");
      const result = pipeline.process(
        "Set the .environment variable for the process"
      );
      const dangerFlags = result.securityFlags.filter(
        (f) => f.type === "dangerous_command"
      );
      expect(dangerFlags).toHaveLength(0);
    });

    it("does NOT flag .envrc (substring of .env)", () => {
      const pipeline = new RedactionPipeline("minimal");
      const result = pipeline.process("Edit the .envrc file");
      const dangerFlags = result.securityFlags.filter(
        (f) => f.type === "dangerous_command"
      );
      expect(dangerFlags).toHaveLength(0);
    });

    it("does NOT flag dotenv (substring of .env)", () => {
      const pipeline = new RedactionPipeline("minimal");
      const result = pipeline.process("Use dotenv to load config");
      const dangerFlags = result.securityFlags.filter(
        (f) => f.type === "dangerous_command"
      );
      expect(dangerFlags).toHaveLength(0);
    });

    it("still flags .env at end of string", () => {
      const pipeline = new RedactionPipeline("minimal");
      const result = pipeline.process("cat .env");
      const dangerFlags = result.securityFlags.filter(
        (f) => f.type === "dangerous_command"
      );
      expect(dangerFlags.length).toBeGreaterThan(0);
      expect(dangerFlags[0].severity).toBe("high");
    });

    it("still flags .env surrounded by whitespace", () => {
      const pipeline = new RedactionPipeline("minimal");
      const result = pipeline.process("vi .env now");
      const dangerFlags = result.securityFlags.filter(
        (f) => f.type === "dangerous_command"
      );
      expect(dangerFlags.length).toBeGreaterThan(0);
    });

    it("still flags .env with path separator", () => {
      const pipeline = new RedactionPipeline("minimal");
      const result = pipeline.process("cat /app/.env");
      const dangerFlags = result.securityFlags.filter(
        (f) => f.type === "dangerous_command"
      );
      expect(dangerFlags.length).toBeGreaterThan(0);
    });

    it("does NOT flag id_rsa.pub (public key, not a secret)", () => {
      const pipeline = new RedactionPipeline("minimal");
      const result = pipeline.process("Add your id_rsa.pub to authorized_keys");
      const dangerFlags = result.securityFlags.filter(
        (f) => f.type === "dangerous_command" && f.detail.includes("id_rsa")
      );
      expect(dangerFlags).toHaveLength(0);
    });

    it("still flags id_rsa private key reference", () => {
      const pipeline = new RedactionPipeline("minimal");
      const result = pipeline.process("cat ~/.ssh/id_rsa");
      const dangerFlags = result.securityFlags.filter(
        (f) => f.type === "dangerous_command" && f.detail.includes("id_rsa")
      );
      expect(dangerFlags.length).toBeGreaterThan(0);
    });

    it("does NOT flag /etc/passwd-like strings that aren't /etc/passwd", () => {
      const pipeline = new RedactionPipeline("minimal");
      const result = pipeline.process("Check /etc/passwd_backup file");
      const dangerFlags = result.securityFlags.filter(
        (f) => f.type === "dangerous_command" && f.detail.includes("/etc/passwd")
      );
      // "passwd_backup" — \b between "passwd" and "_" does NOT match (both are
      // word chars: "d" and "_"), so /etc/passwd_backup is NOT flagged.
      expect(dangerFlags).toHaveLength(0);
    });

    it("still flags /etc/passwd followed by non-word char", () => {
      const pipeline = new RedactionPipeline("minimal");
      const result = pipeline.process("cat /etc/passwd | grep root");
      const dangerFlags = result.securityFlags.filter(
        (f) => f.type === "dangerous_command" && f.detail.includes("/etc/passwd")
      );
      expect(dangerFlags.length).toBeGreaterThan(0);
    });
  });
});
