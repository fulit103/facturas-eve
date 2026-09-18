const SESSION_HASH = /^#\/s\/([^/]+)$/u;

export function sessionIdFromHash(hash = window.location.hash): string | undefined {
  const match = SESSION_HASH.exec(hash);
  return match?.[1] === undefined ? undefined : decodeURIComponent(match[1]);
}

export function hashForSession(sessionId: string): string {
  return `#/s/${encodeURIComponent(sessionId)}`;
}

export function hashForNewChat(): string {
  return "#/";
}
