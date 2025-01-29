import { IUser } from "./user.interface";

export interface ISignUp {
  email: string;
  password: string;
}

export interface ILoginIn {
  email: string;
  password: string;
}

export interface GoogleSignInResponse {
  message: string;
  accessToken: string;
  refreshToken: string;
  user: IUser;
}
