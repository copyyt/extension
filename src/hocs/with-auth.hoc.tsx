"use client";
import { useEffect, useState } from "react";
import { checkJwtExpiry } from "@/utils";
import { useViewStore } from "@/hooks/view-store.hook";
import ViewLoader from "@/components/loader";

export default function withAuth<T>(Component: React.FC<T>) {
  return function IsAuth(props: T & React.JSX.IntrinsicAttributes) {
    const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(
      null,
    );
    const { setCurrentView } = useViewStore();

    useEffect(() => {
      const auth = checkJwtExpiry(localStorage.getItem("accessToken")!);
      if (!auth) {
        return setCurrentView("sign-in");
      }
      setIsAuthenticated(auth);
    }, [setCurrentView]);

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
