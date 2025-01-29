import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Views from "./views";
import ViewLoader from "./components/loader";

const queryClient = new QueryClient();

function App() {
  return (
    <>
      <section className="shadow-copyt relative max-h-[400px] w-[300px] p-4">
        <QueryClientProvider client={queryClient}>
          <ViewLoader />
          <Views />
        </QueryClientProvider>
      </section>
    </>
  );
}

export default App;
