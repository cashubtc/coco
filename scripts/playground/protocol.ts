export type Request = { type: 'execute'; id: number; source: string };
export type Output = {
  level: 'log' | 'info' | 'warn' | 'error' | 'result' | 'event';
  text: string;
};
export type Response =
  | { type: 'ready' }
  | { type: 'output'; id?: number; output: Output }
  | { type: 'done'; id: number; prepared: boolean; error?: string }
  | { type: 'fatal'; error: string };
