import { homedir } from "node:os";

export const CONFIG_DIR = `${homedir()}/.cocod`;
export const SOCKET_PATH = process.env.COCOD_SOCKET || `${CONFIG_DIR}/cocod.sock`;
export const PID_FILE = process.env.COCOD_PID || `${CONFIG_DIR}/cocod.pid`;
export const LOG_FILE = process.env.COCOD_LOG_FILE || `${CONFIG_DIR}/daemon.log`;
export const CONFIG_FILE = `${CONFIG_DIR}/config.json`;
export const SALT_FILE = `${CONFIG_DIR}/salt`;
export const DB_FILE = `${CONFIG_DIR}/coco.db`;

export interface WalletConfig {
  version: number;
  mnemonic: string;
  encrypted: boolean;
  mintUrl: string;
  createdAt: string;
}
