import { useGoogleSignIn } from "@/hooks/auth.hook";
import { useViewLoader } from "@/hooks/loader.hook";
import GoogleIcon from "@/vectors/google";
import Logo from "@/vectors/logo";
import { useState } from "react";

const SignIn = () => {
  const signInGoogle = useGoogleSignIn();
  const [loading, setLoading] = useState(false);
  const handleGoogleAuth = () => {
    setLoading(true);
    chrome.identity.getAuthToken({ interactive: true }, function (token) {
      setLoading(false);
      if (token) {
        signInGoogle.mutate(token);
      }
    });
  };

  useViewLoader([signInGoogle.isPending, loading]);

  return (
    <div className="flex w-full flex-col items-center justify-center gap-8 bg-white py-5">
      <div className="font-sora flex items-center gap-2 text-xl font-bold">
        <Logo /> Copyyt
      </div>

      <p className="font-sora text-center text-lg font-bold">
        Start copying and pasting between browsers and computers in seconds
      </p>
      <button
        onClick={handleGoogleAuth}
        className="flex cursor-pointer items-center gap-2 rounded-xl border border-[#D1D5DB] p-2 hover:opacity-40"
      >
        <GoogleIcon /> Continue with google
      </button>
    </div>
  );
};

export default SignIn;
