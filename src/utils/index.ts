import { jwtDecode } from "jwt-decode";

export const checkJwtExpiry = (token: string) => {
  if (token) {
    const exp = jwtDecode(token)?.exp;
    if (!exp) {
      return false;
    }
    if (Date.now() >= exp * 1000) {
      return false;
    }
    return true;
  }

  return false;
};
