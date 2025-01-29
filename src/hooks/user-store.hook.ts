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
