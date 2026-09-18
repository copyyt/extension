const CHROME_WEB_STORE_URL =
  "https://chromewebstore.google.com/detail/copyyt/ophadgignfjigkbdcmicnklokjeknnbd";
const PRIVACY_POLICY_URL = "https://copyyt.psami.com/privacy-policy";

function PausedWebApp() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#F8FAFC] px-6 py-12 text-[#0F3449]">
      <section className="w-full max-w-lg rounded-2xl bg-white p-8 text-center shadow-[0_18px_60px_rgba(15,52,73,0.12)] sm:p-12">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-[#E3F3FB] text-2xl font-bold text-[#2D9CDB]">
          C
        </div>
        <p className="font-sora mt-6 text-sm font-semibold tracking-[0.18em] text-[#2D9CDB] uppercase">
          Copyyt Web
        </p>
        <h1 className="font-sora mt-3 text-3xl font-bold tracking-tight sm:text-4xl">
          Copyyt Web is currently paused
        </h1>
        <p className="font-work mt-5 text-base leading-7 text-[#4B5563]">
          Copyyt 2.0 is focused on the Chrome extension for secure automatic
          cross-device clipboard sync.
        </p>
        <div className="mt-8 flex flex-col items-center gap-3">
          <a
            className="font-work w-full rounded-lg bg-[#2D9CDB] px-5 py-3 font-semibold text-white transition hover:bg-[#2682B6] focus:ring-2 focus:ring-[#2D9CDB] focus:ring-offset-2 focus:outline-none"
            href={CHROME_WEB_STORE_URL}
          >
            Install Copyyt for Chrome
          </a>
          <a
            className="font-work text-sm font-semibold text-[#1E6892] underline decoration-[#B9DFF1] underline-offset-4 hover:text-[#174E6E]"
            href={PRIVACY_POLICY_URL}
          >
            View the privacy policy
          </a>
        </div>
      </section>
    </main>
  );
}

export default PausedWebApp;
