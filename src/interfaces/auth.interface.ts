import { IUser } from "./user.interface";

export interface ILoginIn {
  email: string;
}

export interface IVerifyEmail {
  email: string;
  name?: string;
  code: number;
}

export interface SignInResponse {
  message: string;
  accessToken: string;
  /** Web cookie sessions may omit the token; extension sessions must validate it before storage. */
  refreshToken?: string;
  user: IUser;
}

export interface ILoginResponse {
  message: string;
  data: { isNew: boolean };
}
