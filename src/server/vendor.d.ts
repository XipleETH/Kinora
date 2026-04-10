declare module 'upng-js' {
  interface Image {
    width: number;
    height: number;
    data: ArrayBuffer;
  }
  function decode(buffer: ArrayBuffer | Uint8Array | Buffer): Image;
  function toRGBA8(img: Image): ArrayBuffer[];
  export default { decode, toRGBA8 };
}

declare module 'gifenc' {
  export function GIFEncoder(): {
    writeFrame(index: Uint8Array, width: number, height: number, opts?: { palette?: number[][]; delay?: number; transparent?: boolean }): void;
    finish(): void;
    bytes(): Uint8Array;
  };
  export function quantize(rgba: Uint8Array, maxColors: number, opts?: any): number[][];
  export function applyPalette(rgba: Uint8Array, palette: number[][], format?: string): Uint8Array;
}
