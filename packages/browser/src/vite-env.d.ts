/// <reference types="vite/client" />

declare module '*.js?raw' {
  const content: string;
  export default content;
}
