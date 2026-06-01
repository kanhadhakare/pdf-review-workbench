declare module "wawoff2" {
  export function compress(buffer: Uint8Array | Buffer): Promise<Uint8Array>;
  export function decompress(buffer: Uint8Array | Buffer): Promise<Uint8Array>;
}
