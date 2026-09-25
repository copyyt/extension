import Button from "@/components/button";
import { InputField } from "@/components/input";
import { useUpdateProfileName } from "@/hooks/auth.hook";
import { useViewLoader } from "@/hooks/loader.hook";
import { useToastStore } from "@/hooks/toast-store.hook";
import Logo from "@/vectors/logo";
import { useState } from "react";

/** One-time step for accounts that don't have a name yet. */
const SetName = () => {
  const [name, setName] = useState("");
  const updateName = useUpdateProfileName();
  const { setToast } = useToastStore();

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    updateName.mutate(trimmed, {
      onError: (error) => {
        setToast({
          open: true,
          text: error instanceof Error && error.message ? error.message : "Unable to save your name.",
        });
      },
    });
  };

  useViewLoader([updateName.isPending]);

  return (
    <div className="w-full bg-surface">
      <div className="font-sora flex items-center gap-2 text-lg font-bold text-ink">
        <Logo /> Copyyt
      </div>

      <h1 className="font-sora mt-8 text-2xl font-bold text-ink">What should we call you?</h1>

      <p className="font-work mt-2 text-sm leading-6 text-muted">
        Your name appears on your account in Copyyt. You can use any name you like.
      </p>

      <form onSubmit={handleSubmit} className="space-y-3 pt-3">
        <InputField
          label="Name"
          placeholder="Joe Xpress"
          name="name"
          autoFocus
          maxLength={100}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Button
          className="mt-3 mb-0 w-full rounded-xl !py-3 !text-base !font-semibold"
          disabled={!name.trim() || updateName.isPending}
        >
          Continue
        </Button>
      </form>
    </div>
  );
};

export default SetName;
