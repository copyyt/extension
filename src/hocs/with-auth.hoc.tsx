"use client";
import { useEffect, useState } from "react";
import { checkJwtExpiry } from "@/utils";
import { useViewStore } from "@/hooks/view-store.hook";
import ViewLoader from "@/components/loader";
import { useRefreshTokens } from "@/hooks/auth.hook";
import { APP_TYPE } from "@/utils/constants";
import { useUserStore } from "@/hooks/user-store.hook";
import { getRuntimeStatus } from "@/runtime/client";
import {
  bootstrapExtensionAuth,
  shouldRefreshWebAuth,
} from "./auth-bootstrap";
import {
  clearWebAccessToken,
  getWebAccessToken,
} from "@/hooks/web-session";

export default function withAuth<T>(Component: React.FC<T>) {
  return function IsAuth(props: T & React.JSX.IntrinsicAttributes) {
    const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(
      null,
    );
    const { setCurrentView } = useViewStore();
    const { setUser } = useUserStore();
    const refreshTokens = useRefreshTokens();

    useEffect(() => {
      if (APP_TYPE === "extension") {
        bootstrapExtensionAuth(getRuntimeStatus)
          .then((result) => {
            if (result.authenticated) {
              setUser(result.user);
              setIsAuthenticated(true);
              return;
            }

            setIsAuthenticated(false);
            setCurrentView(result.view);
          })
          .catch(() => {
            setIsAuthenticated(false);
            setCurrentView("sign-in");
          });
        return;
      }
      if (shouldRefreshWebAuth(getWebAccessToken(), checkJwtExpiry)) {
        refreshTokens.mutate(undefined, {
          onSuccess: () => {
            return setIsAuthenticated(true);
          },
          onError: () => {
            clearWebAccessToken();
            setIsAuthenticated(false);
            return setCurrentView("sign-in");
          },
        });
      } else {
        setIsAuthenticated(true);
      }
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    if (isAuthenticated === null) {
      // Initial state while checking auth
      return <ViewLoader open />;
    }

    if (!isAuthenticated) {
      // Avoid rendering the actual component when not authenticated
      return null;
    }
    return <Component {...props} />;
  };
}
