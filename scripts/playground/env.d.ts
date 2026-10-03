/// <reference types="vite/client" />
declare module 'virtual:playground-types' {
  export const libs: { path: string; content: string }[];
  export const paths: Record<string, string[]>;
  export const eventNames: (keyof import('@cashu/coco-core').CoreEvents)[];
}
