import { getApis } from "@/api";
import { API_URL, APP_TYPE } from "@/utils/constants";
import axios from "axios";
import {
  clearWebAccessToken,
  getWebAccessToken,
} from "./web-session";

export const useAuthAxios = () => {
  const axiosInstance = axios.create({
    baseURL: API_URL + "/api/v1",
    timeout: 120000,
    withCredentials: APP_TYPE === "web",
    headers: APP_TYPE === "web" ? { "X-Copyyt-Client": "web" } : undefined,
  });

  // add interceptors
  axiosInstance.interceptors.response.use(
    (response) => response,
    (error) => {
      if (error?.response?.status === 401) {
        clearWebAccessToken();
        window.location.href = "/";
      }

      return Promise.reject(error);
    },
  );

  axiosInstance.interceptors.request.use(
    async (config) => {
      config.headers.Accept = "application/json";
      const accessToken = getWebAccessToken();
      if (accessToken) {
        config.headers.authorization = `Bearer ${accessToken}`;
      } else {
        delete config.headers.authorization;
      }
      config.timeout = 120000;
      return config;
    },
    (error) => {
      return Promise.reject(error);
    },
  );

  return getApis(axiosInstance);
};

export const useAxios = () => {
  const axiosInstance = axios.create({
    baseURL: API_URL + "/api/v1",
    timeout: 120000,
    withCredentials: APP_TYPE === "web",
    headers: APP_TYPE === "web" ? { "X-Copyyt-Client": "web" } : undefined,
  });

  // add interceptors

  axiosInstance.interceptors.request.use(
    async (config) => {
      config.headers.Accept = "application/json";
      config.timeout = 120000;
      return config;
    },
    (error) => {
      return Promise.reject(error);
    },
  );

  return getApis(axiosInstance);
};
