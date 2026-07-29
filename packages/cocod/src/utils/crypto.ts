export async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const passphraseData = encoder.encode(passphrase);

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    passphraseData,
    { name: "PBKDF2" },
    false,
    ["deriveBits", "deriveKey"],
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: Buffer.from(salt).buffer as ArrayBuffer,
      iterations: 100000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptMnemonic(
  mnemonic: string,
  passphrase: string,
): Promise<{ ciphertext: string; salt: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(passphrase, salt);

  const encoder = new TextEncoder();
  const plaintext = encoder.encode(mnemonic);

  const iv = crypto.getRandomValues(new Uint8Array(12));

  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, key, plaintext);

  const combined = new Uint8Array(iv.length + new Uint8Array(ciphertext).length);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);

  return {
    ciphertext: Buffer.from(combined).toString("base64"),
    salt: Buffer.from(salt).toString("base64"),
  };
}

export async function decryptMnemonic(
  ciphertext: string,
  passphrase: string,
  salt: string,
): Promise<string> {
  const combined = Buffer.from(ciphertext, "base64");
  const saltBytes = Buffer.from(salt, "base64");

  const key = await deriveKey(passphrase, saltBytes);

  const iv = combined.slice(0, 12);
  const encrypted = combined.slice(12);

  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv }, key, encrypted);

  const decoder = new TextDecoder();
  return decoder.decode(decrypted);
}
