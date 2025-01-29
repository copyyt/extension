import { getApis } from "@/api";
import { API_URL } from "@/utils/constants";
import axios from "axios";

export const useAuthAxios = () => {
  const axiosInstance = axios.create({
    baseURL: API_URL + "/api/v1",
    timeout: 120000,
  });

  // add interceptors
  axiosInstance.interceptors.response.use(
    (response) => response,
    (error) => {
      if (error.response.status === 401) {
        window.location.href = "/";
      }

      return Promise.reject(error);
    },
  );

  axiosInstance.interceptors.request.use(
    async (config) => {
      config.headers.Accept = "application/json";
      config.headers.authorization = `Bearer ${localStorage.getItem(
        "accessToken",
      )}`;
      config.timeout = 120000;
      return config;
    },
    (error) => {
      Promise.reject(error);
    },
  );

  return getApis(axiosInstance);
};

export const useAxios = () => {
  const axiosInstance = axios.create({
    baseURL: API_URL,
    timeout: 120000,
  });

  // add interceptors

  axiosInstance.interceptors.request.use(
    async (config) => {
      config.headers.Accept = "application/json";
      config.timeout = 120000;
      return config;
    },
    (error) => {
      Promise.reject(error);
    },
  );

  return getApis(axiosInstance);
};
