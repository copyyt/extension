import { useViewStore } from "@/hooks/view-store.hook";
import SignIn from "./sign-in";
import { useMemo } from "react";
import Home from "./home";
import VerifyEmail from "./verify-email";
import Toast from "@/components/toast";
import SetName from "./set-name";
import { useUserStore } from "@/hooks/user-store.hook";

const Views = () => {
  const { currentView } = useViewStore();
  const { user } = useUserStore();
  // Email sign-in doesn't ask for a name up front (the server won't reveal
  // whether an account is new), so signed-in accounts without one set it here.
  const needsName = currentView === "home" && Boolean(user) && !user?.name?.trim();

  const view = useMemo(() => {
    if (needsName) return <SetName />;
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
  }, [currentView, needsName]);

  return (
    <section>
      <Toast />
      {view}
    </section>
  );
};

export default Views;
