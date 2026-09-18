import { verifyHttpBasic, withAuthChallenges } from "eve/channels/auth";

export const appAuth = withAuthChallenges(
  (request: Request) => {
    const username = process.env.FACTURAS_WEB_USERNAME;
    const password = process.env.FACTURAS_WEB_PASSWORD;
    if (!username || !password) return null;

    if (request.headers.has("origin") && request.headers.get("sec-fetch-site") !== "same-origin") {
      return null;
    }

    const result = verifyHttpBasic(request.headers.get("authorization"), { username, password });
    if (!result.ok) return null;

    return {
      ...result.sessionAuth,
      issuer: "facturas-web",
    };
  },
  [{ scheme: "Basic", parameters: { realm: "facturas", charset: "UTF-8" } }],
);
