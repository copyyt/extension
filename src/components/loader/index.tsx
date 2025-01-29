import { useLoaderStore } from "@/hooks/loader-store.hook";
import { TailSpin } from "react-loader-spinner";

const ViewLoader = () => {
  const { state } = useLoaderStore();
  return (
    <>
      {state ? (
        <section className="absolute top-0 left-0 z-10 flex h-full w-full items-center justify-center bg-white">
          <TailSpin width={40} height={40} color="#2D9CDB" />
        </section>
      ) : null}
    </>
  );
};

export default ViewLoader;
