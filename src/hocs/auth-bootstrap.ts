import type { IUser } from "@/interfaces/user.interface";
import type { RuntimeStatus } from "@/runtime/messages";

export type ExtensionAuthBootstrapResult =
  | { authenticated: true; user: IUser }
  | { authenticated: false; view: "sign-in" };

export function resolveExtensionAuth(
  status: RuntimeStatus,
): ExtensionAuthBootstrapResult {
  if (status.signedIn && status.user) {
    return { authenticated: true, user: status.user };
  }

  return { authenticated: false, view: "sign-in" };
}

export async function bootstrapExtensionAuth(
  getStatus: () => Promise<RuntimeStatus>,
): Promise<ExtensionAuthBootstrapResult> {
  return resolveExtensionAuth(await getStatus());
}

export function shouldRefreshWebAuth(
  accessToken: string | null,
  isJwtValid: (token: string) => boolean,
): boolean {
  return !isJwtValid(accessToken ?? "");
}
