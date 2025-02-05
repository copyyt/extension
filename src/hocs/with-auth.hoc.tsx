"use client";
import { useEffect, useState } from "react";
import { checkJwtExpiry } from "@/utils";
import { useViewStore } from "@/hooks/view-store.hook";
import ViewLoader from "@/components/loader";
import { useRefreshTokens } from "@/hooks/auth.hook";

export default function withAuth<T>(Component: React.FC<T>) {
  return function IsAuth(props: T & React.JSX.IntrinsicAttributes) {
    const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(
      null,
    );
    const { setCurrentView } = useViewStore();
    const refreshTokens = useRefreshTokens();

    console.log("isAuthenticated", isAuthenticated);

    useEffect(() => {
      const auth = checkJwtExpiry(localStorage.getItem("accessToken")!);
      if (!auth) {
        refreshTokens.mutate(undefined, {
          onSuccess: () => {
            return setIsAuthenticated(true);
          },
          onError: () => {
            localStorage.removeItem("accessToken");
            setIsAuthenticated(false);
            return setCurrentView("sign-in");
          },
        });
      } else {
        setIsAuthenticated(auth);
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
