interface ImportMetaEnv {
  readonly VITE_MINT_URL?: string;
  readonly VITE_TEST_LOG_LEVEL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare const process: {
  env: Record<string, string | undefined>;
};
