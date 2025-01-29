import { create } from "zustand";

interface LoaderStore {
  state: boolean;
  setState: (view: boolean) => void;
}

export const useLoaderStore = create<LoaderStore>((set) => ({
  state: false,
  setState: (state: boolean) => set({ state: state }),
}));
