import { describe, expect, test } from "bun:test";

import { decryptMnemonic, encryptMnemonic } from "./crypto";

describe("crypto", () => {
  test("encrypts and decrypts mnemonic", async () => {
    const mnemonic =
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    const passphrase = "secret-passphrase";

    const { ciphertext, salt } = await encryptMnemonic(mnemonic, passphrase);
    const decrypted = await decryptMnemonic(ciphertext, passphrase, salt);

    expect(decrypted).toBe(mnemonic);
  });

  test("fails with wrong passphrase", async () => {
    const mnemonic =
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    const { ciphertext, salt } = await encryptMnemonic(mnemonic, "correct-passphrase");

    await expect(decryptMnemonic(ciphertext, "wrong-passphrase", salt)).rejects.toThrow();
  });
});
