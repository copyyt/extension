import { useEffect } from "react";
import { useLoaderStore } from "./loader-store.hook";

export const useViewLoader = (deps: boolean[]) => {
  const { setState } = useLoaderStore();
  useEffect(() => {
    const activate = deps.some((v) => v);

    setState(activate);

    return () => {
      setState(false);
    };
  }, [...deps]); // eslint-disable-line
};
