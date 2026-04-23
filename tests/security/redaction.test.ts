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
});
