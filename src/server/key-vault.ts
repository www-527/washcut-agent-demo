import {createCipheriv, createDecipheriv, createHash, randomBytes} from 'node:crypto';
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';

const ALGORITHM = 'aes-256-gcm';

const readOrCreateLocalSecret = (databasePath: string) => {
  const configured = process.env.KEY_ENCRYPTION_SECRET?.trim();
  if (configured) return configured;

  if (databasePath === ':memory:') return randomBytes(32).toString('base64url');
  const secretPath = path.join(path.dirname(path.resolve(databasePath)), '.relay-key-secret');
  if (!existsSync(secretPath)) {
    try {
      writeFileSync(secretPath, randomBytes(32).toString('base64url'), {encoding: 'utf8', mode: 0o600, flag: 'wx'});
    } catch (error) {
      if (!existsSync(secretPath)) throw error;
    }
  }
  return readFileSync(secretPath, 'utf8').trim();
};

export class KeyVault {
  private readonly encryptionKey: Buffer;

  constructor(databasePath: string, secret = readOrCreateLocalSecret(databasePath)) {
    this.encryptionKey = createHash('sha256').update(secret, 'utf8').digest();
  }

  encrypt(value: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGORITHM, this.encryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ['v1', iv.toString('base64url'), tag.toString('base64url'), encrypted.toString('base64url')].join(':');
  }

  decrypt(value: string) {
    const [version, encodedIv, encodedTag, encodedData] = value.split(':');
    if (version !== 'v1' || !encodedIv || !encodedTag || !encodedData) throw new Error('relay_key_ciphertext_invalid');
    const decipher = createDecipheriv(ALGORITHM, this.encryptionKey, Buffer.from(encodedIv, 'base64url'));
    decipher.setAuthTag(Buffer.from(encodedTag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(encodedData, 'base64url')), decipher.final()]).toString('utf8');
  }
}

export const maskApiKey = (apiKey: string) => `••••••••${apiKey.slice(-4)}`;
