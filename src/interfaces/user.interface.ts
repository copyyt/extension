export interface IUser {
  id: string;
  name?: string;
  email: string;
  emailVerified: boolean;
  googleSubject?: string;
}
