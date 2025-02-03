import { useViewStore } from "@/hooks/view-store.hook";
import SignIn from "./sign-in";
import { useMemo } from "react";
import Home from "./home";
import VerifyEmail from "./verify-email";
import Toast from "@/components/toast";

const Views = () => {
  const { currentView } = useViewStore();

  const view = useMemo(() => {
    switch (currentView) {
      case "sign-in":
        return <SignIn />;
      case "home":
        return <Home />;
      case "verify-email":
        return <VerifyEmail />;
      default:
        return <SignIn />;
    }
  }, [currentView]);

  return (
    <section className="h-full">
      <Toast />
      {view}
    </section>
  );
};

export default Views;
