import Button from "@/components/button";
import { InputField } from "@/components/input";
import { useGoogleSignIn, useSignInPasswordless } from "@/hooks/auth.hook";
import useGoogleAuthWeb from "@/hooks/google-auth-web.hook";
import { useViewLoader } from "@/hooks/loader.hook";
import { useEmailStore, useIsNewStore } from "@/hooks/user-store.hook";
import { useViewStore } from "@/hooks/view-store.hook";
import { APP_TYPE } from "@/utils/constants";
import GoogleIcon from "@/vectors/google";
import Logo from "@/vectors/logo";
import { useToastStore } from "@/hooks/toast-store.hook";
import { useState } from "react";

const SignIn = () => {
  const signInGoogle = useGoogleSignIn();
  const [loading, setLoading] = useState(false);
  const { email, setEmail } = useEmailStore();
  const { setIsNew } = useIsNewStore();
  const { setCurrentView } = useViewStore();
  const { setToast } = useToastStore();

  const { getToken } = useGoogleAuthWeb();
  const handleGoogleAuth = () => {
    setLoading(true);
    if (APP_TYPE === "web") {
      getToken()
        .then((token) => {
          signInGoogle.mutate(token);
        })
        .catch((error) => {
          setToast({
            open: true,
            text:
              error instanceof Error && error.message
                ? error.message
                : "Google sign-in was cancelled or unavailable.",
          });
        })
        .finally(() => {
          setLoading(false);
        });

      return;
    }
    chrome.identity.getAuthToken({ interactive: true }, function (token) {
      setLoading(false);
      if (token) {
        signInGoogle.mutate(token);
      } else {
        setToast({
          open: true,
          text: "Google sign-in was cancelled or unavailable.",
        });
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
          setIsNew(data.data.isNew);
          setCurrentView("verify-email");
        },
      },
    );
  };

  useViewLoader([signInGoogle.isPending, loading, signIn.isPending]);

  return (
    <div className="w-full bg-white">
      <div className="font-sora flex items-center gap-2 text-lg font-bold text-[#0F3449]">
        <Logo /> Copyyt
      </div>

      <h1 className="font-sora mt-8 text-2xl font-bold text-[#0F3449]">
        Copy here, paste anywhere
      </h1>
      <p className="font-work mt-2 text-sm leading-6 text-[#4B5563]">
        Your clipboard, end-to-end encrypted across your browsers and phone.
        Sign in to get started.
      </p>
      <button
        onClick={handleGoogleAuth}
        className="font-work mt-6 flex w-full cursor-pointer items-center justify-center gap-2 rounded-xl border border-[#D1D5DB] p-3 font-semibold text-[#0F3449] transition-colors hover:bg-[#F8FAFC]"
      >
        <GoogleIcon /> Continue with Google
      </button>

      <div className="font-work mt-5 flex w-full items-center gap-3 text-xs text-[#9CA3AF]">
        <div className="flex-[1] border-b border-b-[#E4E7EC]" />
        or use your email
        <div className="flex-[1] border-b border-b-[#E4E7EC]" />
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
          className="mt-3 w-full rounded-xl !py-3 !text-base !font-semibold"
          disabled={!email}
        >
          Email me a code
        </Button>
      </form>
    </div>
  );
};

export default SignIn;
