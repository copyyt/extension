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
        <div className="border-primary absolute top-2 left-[30%] rounded border p-2">
          {toast.text}
        </div>
      )}
    </>
  );
};

export default Toast;
