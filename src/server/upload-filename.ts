/**
 * Multer's multipart parser may expose a UTF-8 filename as a Latin-1 string
 * (for example, "洗车.mp4" becomes "æ´—è½¦.mp4"). Reinterpret only strings
 * that round-trip as valid UTF-8 bytes so genuine Latin-1 names stay intact.
 */
export const decodeMultipartFilename = (fileName: string) => {
  const normalized = fileName.normalize('NFC');
  if (![...normalized].every((character) => (character.codePointAt(0) ?? 0) <= 0xff)) return normalized;

  const sourceBytes = Buffer.from(normalized, 'latin1');
  const decoded = sourceBytes.toString('utf8').normalize('NFC');
  if (decoded.includes('\uFFFD') || !Buffer.from(decoded, 'utf8').equals(sourceBytes)) return normalized;
  return decoded;
};
