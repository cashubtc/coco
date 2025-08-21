export interface Keyset {
  mintUrl: string;
  id: string;
  keypairs: Record<number, string>; // JSON string
  active: boolean;
  feePpk: number;
  updatedAt: number;
}
