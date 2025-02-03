import { IUser } from "@/interfaces/user.interface";
import { persist } from "zustand/middleware";
import { create } from "zustand";

interface UserStore {
  user: IUser | null;
  setUser: (user: IUser) => void;
  clearUser: () => void;
}

export const useUserStore = create<UserStore>()(
  persist(
    (set) => ({
      user: null,
      setUser: (user: IUser) => set({ user }),
      clearUser: () => set({ user: null }),
    }),
    { name: "user-storage" },
  ),
);

interface EmailStore {
  email: string;
  setEmail: (email: string) => void;
}

export const useEmailStore = create<EmailStore>((set) => ({
  email: "",
  setEmail: (email: string) => set({ email }),
}));

interface IsNewStore {
  isNew: boolean;
  setIsNew: (isNew: boolean) => void;
  clearState: () => void;
}

export const useIsNewStore = create<IsNewStore>((set) => ({
  isNew: false,
  setIsNew: (isNew: boolean) => set({ isNew }),
  clearState: () => set({ isNew: false }),
}));
