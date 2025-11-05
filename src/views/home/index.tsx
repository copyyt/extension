import withAuth from "@/hocs/with-auth.hoc";
import Button from "@/components/button";
import { useLogout } from "@/hooks/auth.hook";
import { useUserStore } from "@/hooks/user-store.hook";
import Logo from "@/vectors/logo";
import { useEffect, useState } from "react";
import { useSocket } from "@/hooks/socket.hook";
import useDebounce from "@/hooks/debounce.hook";
import { useGetLastMessage } from "@/hooks/user.hook";
import { useViewLoader } from "@/hooks/loader.hook";
import LogoutIcon from "@/vectors/logout";
import PasteIcon from "@/vectors/paste";
import CopyIcon from "@/vectors/copy-icon";

const Home = () => {
  const { user } = useUserStore();
  const logout = useLogout();

  const [text, setText] = useState("");

  const lastMessageQuery = useGetLastMessage();
  const lastMessage = lastMessageQuery.data?.data?.data;

  const onMessage = (value: string) => {
    if (value !== text) {
      setText(value);
    }
  };

  useEffect(() => {
    if (lastMessage) {
      setText(lastMessage);
    }
  }, [lastMessage]);

  const { socket, isConnected } = useSocket(onMessage);

  const pasteClipboard = async () => {
    try {
      const clipboardContents = await navigator.clipboard.readText();
      setText(clipboardContents);
    } catch (error) {
      console.error(error);
    }
  };

  async function writeClipboardText() {
    try {
      await navigator.clipboard.writeText(text);
    } catch (error) {
      console.error(error);
    }
  }

  useDebounce(
    () => {
      if (text && isConnected) {
        socket.emit("message", text);
      }
    },
    1000,
    [text],
  );

  useViewLoader([lastMessageQuery.isLoading]);
  return (
    <section className="flex h-full flex-col sm:block">
      <div className="flex items-center justify-between">
        <div className="font-sora flex items-center gap-2 font-bold">
          <Logo /> Copyyt
        </div>
        <div className="flex items-center gap-5">
          <Button
            variant="outlined"
            className="flex items-center gap-2 !border-[#FF2635] !text-[#FF2635]"
            onClick={logout}
          >
            <LogoutIcon />
            Logout
          </Button>
          <div className="relative flex h-10 w-10 items-center justify-center rounded-full bg-[#1E6892] font-semibold text-white uppercase">
            {(user?.name ?? "o").slice(0, 1)}
          </div>
        </div>
      </div>

      <p className="font-work mt-4 text-sm text-[#4B5563]">
        This extension helps you copy text across various computers using the
        the extension. Just paste here and pick up there.
      </p>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="mt-7 h-[200px] w-full flex-1 resize-none rounded-lg border border-[#D1D5DB] p-2 text-xs outline-none"
      />

      <div className="mt-2 flex justify-end gap-2">
        <Button
          variant="outlined"
          className="flex items-center gap-2"
          onClick={pasteClipboard}
        >
          <PasteIcon />
          Paste
        </Button>
        <Button
          variant="primary"
          className="flex items-center gap-2"
          onClick={writeClipboardText}
        >
          <CopyIcon />
          Copy
        </Button>
      </div>
    </section>
  );
};

const HomeWithAuth = withAuth(Home);

export default HomeWithAuth;
