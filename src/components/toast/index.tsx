import { useToastStore } from "@/hooks/toast-store.hook";
import { useEffect } from "react";

const Toast = () => {
  const { toast, setToast } = useToastStore();

  useEffect(() => {
    if (toast.open) {
      setTimeout(() => {
        setToast({ open: false, text: "" });
      }, 3000);
    }
  }, [toast.open]); // eslint-disable-line

  return (
    <>
      {toast.open && (
        <div
          role="status"
          className="font-work absolute top-3 left-1/2 z-20 w-[85%] -translate-x-1/2 rounded-xl bg-ink px-4 py-2.5 text-center text-sm text-page shadow-lg"
        >
          {toast.text}
        </div>
      )}
    </>
  );
};

export default Toast;
