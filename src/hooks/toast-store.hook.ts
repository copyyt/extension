import { create } from "zustand";

interface Toast {
  open: boolean;
  text: string;
}

interface ToastStore {
  toast: Toast;
  setToast: (view: Toast) => void;
}

export const useToastStore = create<ToastStore>((set) => ({
  toast: {
    open: false,
    text: "",
  },
  setToast: (toast: Toast) => set({ toast }),
  clearState: () => set({ toast: { open: false, text: "" } }),
}));
