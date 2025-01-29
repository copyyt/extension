import { useEffect } from "react";

const useDebounce = <T>(func: () => void, delay: number, deps: T[]) => {
  useEffect(() => {
    const t = setTimeout(() => {
      func();
    }, delay);

    return () => {
      clearTimeout(t);
    };
  }, [...deps]); // eslint-disable-line
};

export default useDebounce;
