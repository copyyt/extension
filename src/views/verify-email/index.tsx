import Button from "@/components/button";
import { InputField } from "@/components/input";
import OTPInput from "@/components/otp-input";
import { useResendEmaiOtp, useVerifyEmail } from "@/hooks/auth.hook";
import { useViewLoader } from "@/hooks/loader.hook";
import { useEmailStore, useIsNewStore } from "@/hooks/user-store.hook";
import { useViewStore } from "@/hooks/view-store.hook";
import Logo from "@/vectors/logo";
import { useState } from "react";

const VerifyEmail = () => {
  const { email } = useEmailStore();
  const { isNew, clearState } = useIsNewStore();
  const { setCurrentView } = useViewStore();
  const [data, setData] = useState({
    code: new Array(6).fill(""),
    name: "",
  });

  const verifyEmail = useVerifyEmail();

  const resendEmailOtp = useResendEmaiOtp();

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (data.code.includes("")) return;
    verifyEmail.mutate(
      { email, code: Number(data.code.join("")), name: data.name },
      {
        onSuccess: () => {
          setCurrentView("home");
          clearState();
        },
      },
    );
  };

  useViewLoader([verifyEmail.isPending, resendEmailOtp.isPending]);

  return (
    <div className="w-full items-center justify-center bg-white">
      <div className="font-sora flex items-center gap-2 font-bold">
        <Logo /> Copyyt
      </div>

      <p className="font-sora mt-6 text-center text-sm font-medium">
        Check your email for a code
      </p>

      <p className="font-work mt-3 text-center text-[#4B5563]">
        We've sent a 6-digit OTP to {email}. The code expires after 10mins.{" "}
      </p>

      <form onSubmit={handleSubmit} className="space-y-3 pt-3">
        <OTPInput
          otp={data.code}
          setOtp={(code: string[]) => setData((prev) => ({ ...prev, code }))}
        />
        {isNew ? (
          <InputField
            label="Name"
            placeholder="Joe Xpress"
            name="name"
            value={data.name}
            onChange={(e) =>
              setData((prev) => ({ ...prev, name: e.target.value }))
            }
          />
        ) : null}

        <Button
          className="mt-3 mb-0 w-full rounded-xl !py-4 !text-lg !font-medium"
          disabled={data.code.includes("") || (isNew && !data.name)}
        >
          Continue
        </Button>

        <p className="font-work mt-6 text-center">
          Didn't get code?{" "}
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
