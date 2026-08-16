import { describe, expect, it } from "vitest";

import { normalizeEndpoint, sanitizeMessage } from "../src/transport.js";
import { InvalidRequestError } from "../src/errors.js";

describe("normalizeEndpoint", () => {
  it("accepts a plain https endpoint and strips trailing slash", () => {
    const result = normalizeEndpoint("https://api.example.test/");
    expect(result.url).toBe("https://api.example.test");
    expect(result.target).toBe("api.example.test");
  });

  it("preserves a non-root path", () => {
    const result = normalizeEndpoint("https://api.example.test/grpc");
    expect(result.url).toBe("https://api.example.test/grpc");
    expect(result.target).toBe("api.example.test/grpc");
  });

  it("preserves an explicit port", () => {
    const result = normalizeEndpoint("https://api.example.test:8443");
    expect(result.target).toBe("api.example.test:8443");
  });

  it("rejects non-https schemes", () => {
    expect(() => normalizeEndpoint("http://example.test")).toThrow(InvalidRequestError);
  });

  it("rejects userinfo", () => {
    expect(() => normalizeEndpoint("https://u:p@example.test")).toThrow(InvalidRequestError);
  });

  it("rejects query strings", () => {
    expect(() => normalizeEndpoint("https://example.test/path?q=1")).toThrow(InvalidRequestError);
  });

  it("rejects fragments", () => {
    expect(() => normalizeEndpoint("https://example.test/path#frag")).toThrow(InvalidRequestError);
  });

  it("rejects a malformed port", () => {
    expect(() => normalizeEndpoint("https://example.test:bad")).toThrow(InvalidRequestError);
  });

  it("rejects an empty endpoint", () => {
    expect(() => normalizeEndpoint("   ")).toThrow(InvalidRequestError);
  });

  it("rejects an unparseable endpoint", () => {
    expect(() => normalizeEndpoint("not a url")).toThrow(InvalidRequestError);
  });
});

describe("sanitizeMessage", () => {
  it("redacts every occurrence of a secret", () => {
    const result = sanitizeMessage("token=secret-api and again secret-api", ["secret-api"]);
    expect(result).not.toContain("secret-api");
    expect(result).toContain("[redacted]");
  });

  it("redacts path-like substrings", () => {
    const result = sanitizeMessage("failed to open /var/lib/bonya/snapshots for read", []);
    expect(result).not.toContain("/var/lib/bonya/snapshots");
    expect(result).toContain("[redacted-path]");
  });

  it("ignores empty/undefined secrets", () => {
    const result = sanitizeMessage("plain message", ["", undefined]);
    expect(result).toBe("plain message");
  });

  it("handles non-string message values", () => {
    const result = sanitizeMessage(new Error("boom secret-api"), ["secret-api"]);
    expect(result).toContain("boom");
    expect(result).not.toContain("secret-api");
  });
});
