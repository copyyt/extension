import axios from "axios";
import { getApis } from "../api/index.ts";
import { API_URL } from "../utils/constants.ts";

export function createRuntimeApi(accessToken: string) {
  const axiosInstance = axios.create({
    baseURL: `${API_URL}/api/v1`,
    timeout: 120000,
    withCredentials: true,
  });
  axiosInstance.interceptors.request.use((config) => {
    config.headers.Accept = "application/json";
    if (accessToken) {
      config.headers.authorization = `Bearer ${accessToken}`;
    }
    return config;
  });
  return getApis(axiosInstance);
}
