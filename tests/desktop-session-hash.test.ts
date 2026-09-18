import { describe, expect, it } from "vitest";
import { hashForNewChat, hashForSession, sessionIdFromHash } from "../desktop/src/session-hash";

describe("desktop session hash", () => {
  it("round-trips a session id", () => {
    const hash = hashForSession("abc/def");
    expect(hash).toBe("#/s/abc%2Fdef");
    expect(sessionIdFromHash(hash)).toBe("abc/def");
  });

  it("treats a new-chat hash as no session", () => {
    expect(hashForNewChat()).toBe("#/");
    expect(sessionIdFromHash("#/")).toBeUndefined();
    expect(sessionIdFromHash("")).toBeUndefined();
  });
});
