import { useViewStore } from "@/hooks/view-store.hook";
import SignIn from "./sign-in";
import { useMemo } from "react";
import Home from "./home";

const Views = () => {
  const { currentView } = useViewStore();

  const view = useMemo(() => {
    switch (currentView) {
      case "sign-in":
        return <SignIn />;
      case "home":
        return <Home />;
      default:
        return <SignIn />;
    }
  }, [currentView]);

  return <section className="h-full">{view}</section>;
};

export default Views;
