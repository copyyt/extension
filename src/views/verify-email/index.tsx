import Button from "@/components/button";
import OTPInput from "@/components/otp-input";
import { useResendEmaiOtp, useVerifyEmail } from "@/hooks/auth.hook";
import { useViewLoader } from "@/hooks/loader.hook";
import { useEmailStore } from "@/hooks/user-store.hook";
import { useViewStore } from "@/hooks/view-store.hook";
import Logo from "@/vectors/logo";
import { useState } from "react";

const VerifyEmail = () => {
  const { email } = useEmailStore();
  const { setCurrentView } = useViewStore();
  const [data, setData] = useState({
    code: new Array(6).fill(""),
  });

  const verifyEmail = useVerifyEmail();

  const resendEmailOtp = useResendEmaiOtp();

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (data.code.includes("")) return;
    verifyEmail.mutate(
      { email, code: Number(data.code.join("")) },
      {
        onSuccess: () => {
          setCurrentView("home");
        },
      },
    );
  };

  useViewLoader([verifyEmail.isPending, resendEmailOtp.isPending]);

  return (
    <div className="w-full bg-surface">
      <div className="font-sora flex items-center gap-2 text-lg font-bold text-ink">
        <Logo /> Copyyt
      </div>

      <h1 className="font-sora mt-8 text-2xl font-bold text-ink">
        Check your email
      </h1>

      <p className="font-work mt-2 text-sm leading-6 text-muted">
        We sent a 6-digit code to <span className="font-semibold text-ink">{email}</span>.
        It expires in 10 minutes.
      </p>

      <form onSubmit={handleSubmit} className="space-y-3 pt-3">
        <OTPInput
          otp={data.code}
          setOtp={(code: string[]) => setData((prev) => ({ ...prev, code }))}
        />
        <Button
          className="mt-3 mb-0 w-full rounded-xl !py-3 !text-base !font-semibold"
          disabled={data.code.includes("")}
        >
          Continue
        </Button>

        <p className="font-work mt-6 text-center text-sm text-muted">
          Didn't get the code?{" "}
          <button
            type="button"
            onClick={() => {
              resendEmailOtp.mutate(email);
            }}
            className="text-primary cursor-pointer font-semibold underline hover:opacity-70"
          >
            Resend
          </button>{" "}
        </p>
      </form>
    </div>
  );
};

export default VerifyEmail;
