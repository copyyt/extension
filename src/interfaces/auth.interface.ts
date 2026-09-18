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
  refreshToken: string;
  user: IUser;
}

export interface ILoginResponse {
  message: string;
  data: { isNew: boolean };
}
