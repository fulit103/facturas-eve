const ALLOWED = new Set(["media", "camera"]);

export function isDesktopMediaPermission(permission: string): boolean {
  return ALLOWED.has(permission);
}

export function isAllowedDesktopRendererOrigin(origin: string): boolean {
  if (origin === "" || origin === "null") return true;
  return (
    origin.startsWith("http://localhost") ||
    origin.startsWith("https://localhost") ||
    origin.startsWith("http://127.0.0.1") ||
    origin.startsWith("https://127.0.0.1") ||
    origin.startsWith("file:")
  );
}

export function shouldAllowDesktopPermissionCheck(
  permission: string,
  requestingOrigin: string,
): boolean {
  return isDesktopMediaPermission(permission) || isAllowedDesktopRendererOrigin(requestingOrigin);
}
