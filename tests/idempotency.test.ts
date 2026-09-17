import { describe, expect, it } from "vitest";

import { buildBusinessKey, buildIdempotencyKey, sha256Hex } from "#lib/idempotency.js";

const BYTES_A = new TextEncoder().encode("%PDF-1.7 factura A");
const BYTES_B = new TextEncoder().encode("%PDF-1.7 factura B");

describe("sha256Hex", () => {
  it("is stable for identical bytes and different for different bytes", () => {
    expect(sha256Hex(BYTES_A)).toBe(sha256Hex(new Uint8Array(BYTES_A)));
    expect(sha256Hex(BYTES_A)).not.toBe(sha256Hex(BYTES_B));
  });

  it("produces a 64-character hex digest", () => {
    expect(sha256Hex(BYTES_A)).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe("buildIdempotencyKey", () => {
  it("derives the key from the content hash by default", () => {
    const hash = sha256Hex(BYTES_A);
    expect(buildIdempotencyKey({ contentHash: hash })).toBe(`sha256:${hash}`);
  });

  it("prefers a provider file id when one is available", () => {
    expect(
      buildIdempotencyKey({ providerFileId: "AgADBAADr", contentHash: sha256Hex(BYTES_A) }),
    ).toBe("telegram-file:AgADBAADr");
  });

  it("ignores a blank provider file id", () => {
    const hash = sha256Hex(BYTES_A);
    expect(buildIdempotencyKey({ providerFileId: "   ", contentHash: hash })).toBe(`sha256:${hash}`);
    expect(buildIdempotencyKey({ providerFileId: null, contentHash: hash })).toBe(`sha256:${hash}`);
  });

  it("gives the same key when the same file is sent twice", () => {
    const resend = buildIdempotencyKey({ contentHash: sha256Hex(new Uint8Array(BYTES_A)) });
    expect(buildIdempotencyKey({ contentHash: sha256Hex(BYTES_A) })).toBe(resend);
  });
});

describe("buildBusinessKey", () => {
  it("normalizes separators and case", () => {
    expect(buildBusinessKey("900.123.456-7", "FE-1234")).toBe("9001234567:fe-1234");
    expect(buildBusinessKey("900123456-7", "FE-1234")).toBe(buildBusinessKey("900.123.4567", "fe-1234"));
  });

  it("returns null when either half is missing", () => {
    expect(buildBusinessKey(null, "FE-1234")).toBeNull();
    expect(buildBusinessKey("900123456-7", null)).toBeNull();
    expect(buildBusinessKey("  ", "FE-1234")).toBeNull();
  });
});
