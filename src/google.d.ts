// src/types/google.d.ts
declare global {
  interface Window {
    google: typeof google;
  }

  namespace google {
    namespace accounts {
      namespace oauth2 {
        interface TokenClientConfig {
          client_id: string;
          scope: string;
          prompt?: string;
          callback: (response: TokenResponse) => void;
          hint?: string;
        }

        interface TokenResponse {
          access_token: string;
          expires_in: number;
          prompt: string;
          token_type: string;
          scope?: string;
        }

        function initTokenClient(config: TokenClientConfig): TokenClient;

        interface TokenClient {
          requestAccessToken(): void;
          callback: (response: TokenResponse) => void;
        }

        function revoke(token: string, done?: () => void): void;
      }
    }
  }
}

export {};
