import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Views from "./views";
import ViewLoader from "./components/loader";
import CloseIcon from "./vectors/close";
import { APP_TYPE } from "./utils/constants";
import { useEffect } from "react";

const queryClient = new QueryClient();

function ActiveApp() {
  useEffect(() => {
    if (APP_TYPE === "extension") return;
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    document.body.appendChild(script);

    if (!document.querySelector('link[rel="manifest"]')) {
      const manifestLink = document.createElement("link");
      manifestLink.rel = "manifest";
      manifestLink.href = "/manifest.json";
      document.head.appendChild(manifestLink);
    }
  }, []);

  const extensionClassName =
    "shadow-copyt relative max-h-[600px] w-[430px] overflow-y-auto bg-surface p-6 pt-10 text-ink";
  const webClassName =
    "shadow-copyt relative mx-auto mt-[5vh] h-[90vh] w-full border border-line bg-surface p-6 pt-10 text-ink sm:mt-[calc(50vh-300px)] sm:h-max sm:max-h-[600px] sm:w-[430px]";

  return (
    <>
      <section
        className={APP_TYPE === "extension" ? extensionClassName : webClassName}
      >
        {APP_TYPE === "extension" ? (
          <CloseIcon
            className="absolute top-2 right-2 cursor-pointer text-muted hover:text-ink"
            onClick={() => window.close()}
          />
        ) : null}

        <QueryClientProvider client={queryClient}>
          <ViewLoader />
          <Views />
        </QueryClientProvider>
      </section>
    </>
  );
}

export default ActiveApp;
