import { lazy, Suspense } from "react";
import PausedWebApp from "./views/paused-web-app";
import { APP_TYPE, WEB_APP_PAUSED } from "./utils/constants";

const ActiveApp = lazy(() => import("./ActiveApp"));

function App() {
  if (APP_TYPE === "web" && WEB_APP_PAUSED) {
    return <PausedWebApp />;
  }

  return (
    <Suspense fallback={null}>
      <ActiveApp />
    </Suspense>
  );
}

export default App;
