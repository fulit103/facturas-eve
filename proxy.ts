import { routeAuth } from "eve/channels/auth";
import { NextResponse } from "next/server";
import { appAuth } from "./agent/lib/auth";

export async function proxy(request: Request) {
  if (process.env.NODE_ENV === "development") return NextResponse.next();
  const result = await routeAuth(request, appAuth);
  return result instanceof Response ? result : NextResponse.next();
}

export const config = { matcher: ["/", "/s/:path*"] };
