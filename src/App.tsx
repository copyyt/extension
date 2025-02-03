import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Views from "./views";
import ViewLoader from "./components/loader";
import CloseIcon from "./vectors/close";

const queryClient = new QueryClient();

function App() {
  return (
    <>
      <section className="shadow-copyt relative max-h-[600px] w-[430px] p-6 pt-10">
        <CloseIcon
          className="absolute top-2 right-2 cursor-pointer hover:opacity-60"
          onClick={() => window.close()}
        />
        <QueryClientProvider client={queryClient}>
          <ViewLoader />
          <Views />
        </QueryClientProvider>
      </section>
    </>
  );
}

export default App;
