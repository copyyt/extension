/**
 * The web app deliberately keeps its short-lived access token in memory only.
 * The refresh token is owned by the HttpOnly cookie set by the backend, so a
 * page reload can recover the session by calling /auth/refresh-tokens without
 * exposing a durable credential to JavaScript storage.
 */
let accessToken: string | null = null;

export function getWebAccessToken(): string | null {
  return accessToken;
}

export function setWebAccessToken(token: string): void {
  if (!token.trim()) {
    throw new TypeError("The web access token must not be empty");
  }
  accessToken = token;
}

export function clearWebAccessToken(): void {
  accessToken = null;
}

