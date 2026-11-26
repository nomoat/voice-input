export declare function varint(value: number | bigint): Buffer;
export declare const uint: (field: number, value: number | bigint | string) => Buffer;
export declare const bytes: (field: number, value: string | Buffer) => Buffer;
export type Field = [number, bigint | Buffer];
export declare function parse(data: Buffer): Field[];
export declare const field: (data: Buffer, number: number) => bigint | Buffer | undefined;
export declare const bufferField: (data: Buffer, number: number) => Buffer | undefined;
export declare const intField: (data: Buffer, number: number) => bigint | undefined;
export declare const hash: (algorithm: string, data: string | Buffer) => string;
export declare function crypt(key: string, data: Buffer, decrypt?: boolean): Buffer;
export declare function compress(data: Buffer): Buffer;
export declare function decompress(data: Buffer): Buffer;
export declare function request(task: number, path: string, headers: Record<string, string | number>, body: Buffer): Buffer;
export declare function response(data: Buffer): {
    seq: number;
    status: number;
    headers: Record<string, string>;
    body: Buffer;
} | null;
export declare class OggOpusPackets {
    private readonly onPacket;
    private carry;
    private packet;
    private packetSize;
    constructor(onPacket: (packet: Buffer) => void);
    write(data: Buffer): void;
    finish(): void;
}
