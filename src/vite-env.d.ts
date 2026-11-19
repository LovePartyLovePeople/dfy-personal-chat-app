/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_EDITION: "public" | "personal";
  readonly VITE_APP_NAME: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}