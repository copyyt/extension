import { GOOGLE_CLIENT_ID_WEB } from "@/utils/constants";
import { useEffect, useState } from "react";

const useGoogleAuthWeb = () => {
  const [client, setClient] = useState<any>(null);

  useEffect(() => {
    const interval = setInterval(() => {
      if (window.google?.accounts?.oauth2) {
        clearInterval(interval);
        initClient();
      }
    }, 500);

    function initClient() {
      const tokenClient = window.google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CLIENT_ID_WEB,
        scope: "openid email profile",
        callback: () => {}, // temporary placeholder
      });
      setClient(tokenClient);
    }
  }, []);

  /** Request token and return it as a Promise */
  const getToken = (): Promise<string> => {
    return new Promise((resolve, reject) => {
      if (!client) {
        reject(new Error("Google OAuth client not initialized"));
        return;
      }

      // override callback to resolve when token is received
      client.callback = (tokenResponse: any) => {
        if (tokenResponse?.access_token) {
          resolve(tokenResponse.access_token);
        } else {
          reject(new Error("Failed to obtain access token"));
        }
      };

      try {
        client.requestAccessToken();
      } catch (err) {
        reject(err);
      }
    });
  };

  const revokeToken = async (token: string) => {
    if (!token) return;
    window.google.accounts.oauth2.revoke(token, () =>
      console.log("Access token revoked"),
    );
  };

  return { getToken, revokeToken };
};

export default useGoogleAuthWeb;
