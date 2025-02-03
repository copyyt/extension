import Button from "@/components/button";
import { InputField } from "@/components/input";
import { useGoogleSignIn, useSignInPasswordless } from "@/hooks/auth.hook";
import { useViewLoader } from "@/hooks/loader.hook";
import { useEmailStore, useIsNewStore } from "@/hooks/user-store.hook";
import { useViewStore } from "@/hooks/view-store.hook";
import GoogleIcon from "@/vectors/google";
import Logo from "@/vectors/logo";
import { useState } from "react";

const SignIn = () => {
  const signInGoogle = useGoogleSignIn();
  const [loading, setLoading] = useState(false);
  const { email, setEmail } = useEmailStore();
  const { setIsNew } = useIsNewStore();
  const { setCurrentView } = useViewStore();
  const handleGoogleAuth = () => {
    setLoading(true);
    chrome.identity.getAuthToken({ interactive: true }, function (token) {
      setLoading(false);
      if (token) {
        signInGoogle.mutate(token);
      }
    });
  };
  const signIn = useSignInPasswordless();

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    signIn.mutate(
      { email },
      {
        onSuccess: (data) => {
          setIsNew(data.data.data.isNew);
          setCurrentView("verify-email");
        },
      },
    );
  };

  useViewLoader([signInGoogle.isPending, loading, signIn.isPending]);

  return (
    <div className="w-full items-center justify-center bg-white">
      <div className="font-sora flex items-center gap-2 font-bold">
        <Logo /> Copyyt
      </div>

      <p className="font-sora mt-6 text-center text-sm font-medium">
        Start copying and pasting between browsers and computers in seconds
      </p>
      <button
        onClick={handleGoogleAuth}
        className="mt-3 flex w-full cursor-pointer items-center justify-center gap-2 rounded-xl border border-[#D1D5DB] p-2 hover:opacity-40"
      >
        <GoogleIcon /> Continue with google
      </button>

      <div className="mt-4 flex w-full items-center gap-3 text-sm">
        <div className="flex-[1] border-b border-b-[#D1D5DB]" />
        OR
        <div className="flex-[1] border-b border-b-[#D1D5DB]" />
      </div>

      <form onSubmit={handleSubmit}>
        <InputField
          label="Email"
          placeholder="joexpress@yahoo.com"
          name="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          type="email"
        />

        <Button
          className="mt-3 w-full rounded-xl !py-4 !text-lg !font-medium"
          disabled={!email}
        >
          Continue
        </Button>
      </form>
    </div>
  );
};

export default SignIn;
