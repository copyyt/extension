import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Views from "./views";
import ViewLoader from "./components/loader";
import CloseIcon from "./vectors/close";

const queryClient = new QueryClient();

function App() {
  return (
    <>
      <section className="shadow-copyt relative max-h-[600px] w-[400px] p-4 pt-6">
        <CloseIcon
          className="absolute top-1 right-1"
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
