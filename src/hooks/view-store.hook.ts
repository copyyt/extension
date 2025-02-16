import { create } from "zustand";

interface ViewStore {
  currentView: string;
  setCurrentView: (view: string) => void;
}

export const useViewStore = create<ViewStore>((set) => ({
  currentView: "home",
  setCurrentView: (view: string) => set({ currentView: view }),
}));
