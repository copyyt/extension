import { jwtDecode } from "jwt-decode";

export const checkJwtExpiry = (token: string) => {
  if (!token) return false;
  try {
    const exp = jwtDecode<{ exp?: unknown }>(token).exp;
    return typeof exp === "number" && Number.isFinite(exp) && Date.now() < exp * 1000;
  } catch {
    // A malformed token is equivalent to an expired token. This keeps auth
    // bootstrap on the refresh path instead of crashing the application.
    return false;
  }
};
