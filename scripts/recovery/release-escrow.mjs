import { constants, createCipheriv, createDecipheriv, createHash, createHmac,
  createPrivateKey, createPublicKey, privateDecrypt, publicEncrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { mkdir, open, rm, realpath } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';

/** Sum of original file bytes accepted by one release. */
export const MAX_INPUT_BYTES = 64 * 1024 * 1024;
/** Bounds both the JSON archive and encrypted artifact. */
export const MAX_ARTIFACT_BYTES = 96 * 1024 * 1024;
const MAX_FILES = 10_000;
const MAX_METADATA_BYTES = 4 * 1024 * 1024;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = (message) => { throw new Error(message); };
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function base64(value, maximum, exact) {
  if (typeof value !== 'string' || value.length > Math.ceil(maximum / 3) * 4) fail('Invalid base64 data.');
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length > maximum || decoded.toString('base64') !== value ||
      (exact !== undefined && decoded.length !== exact)) fail('Invalid base64 data.');
  return decoded;
}

function releaseId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) fail('Invalid release ID.');
}

/** Reject traversal, portable-path aliases, duplicate names, and file/directory collisions. */
export function validateArchivePaths(paths) {
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_FILES) fail('Invalid archive file count.');
  const seen = new Set();
  const directories = new Set();
  for (const path of paths) {
    if (typeof path !== 'string' || path.length > 256 || !/^[A-Za-z0-9._/-]+$/.test(path)) fail('Invalid archive path.');
    const parts = path.split('/');
    if (parts.some((part) => !part || part === '.' || part === '..' || part.endsWith('.') ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) fail('Invalid archive path.');
    const normalized = path.toLowerCase();
    if (seen.has(normalized) || directories.has(normalized)) fail('Archive path collision.');
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join('/').toLowerCase();
      if (seen.has(parent)) fail('Archive path collision.');
      directories.add(parent);
    }
    seen.add(normalized);
  }
}

async function readBounded(path, maximum) {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maximum) fail('Input must be a bounded regular file.');
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) fail('Input changed during read.');
      offset += bytesRead;
    }
    const probe = Buffer.alloc(1);
    if ((await handle.read(probe, 0, 1, offset)).bytesRead !== 0) fail('Input changed during read.');
    return bytes;
  } finally {
    await handle.close();
  }
}

function parseJson(bytes) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail('Invalid JSON input.'); }
}

function authenticationKey(value) {
  const key = base64(value, 64);
  if (key.length < 32) fail('Authentication key must contain at least 32 bytes.');
  return key;
}

function keyId(key) { return digest(JSON.stringify(['RSA', key.n, key.e])); }

async function readKit(path) {
  const kit = parseJson(await readBounded(path, 64 * 1024));
  if (!isObject(kit) || kit.version !== 1 || !isObject(kit.publicKey) || !isObject(kit.privateKey) ||
      kit.publicKey.kty !== 'RSA' || kit.publicKey.d || kit.privateKey.kty !== 'RSA' || !kit.privateKey.d ||
      typeof kit.capabilityKey !== 'string' || !kit.capabilityKey) fail('Invalid offline recovery kit.');
  authenticationKey(kit.authenticationKey);
  const publicKey = createPublicKey({ key: kit.publicKey, format: 'jwk' });
  const privateKey = createPrivateKey({ key: kit.privateKey, format: 'jwk' });
  if (publicKey.asymmetricKeyDetails.modulusLength < 3072 ||
      !publicKey.equals(createPublicKey(privateKey))) fail('Recovery RSA keys must match and contain at least 3072 bits.');
  return { ...kit, publicKeyObject: publicKey, privateKeyObject: privateKey };
}

/** Exact bytes authenticated by the release manifest's HMAC. */
export function releaseManifestPayload(manifest) {
  if (!isObject(manifest) || manifest.version !== 1) fail('Unsupported release manifest.');
  releaseId(manifest.releaseId);
  const envelope = manifest.keyEnvelope;
  if (!Number.isSafeInteger(manifest.bytes) || manifest.bytes < 16 || manifest.bytes > MAX_ARTIFACT_BYTES ||
      typeof manifest.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.sha256) || !isObject(envelope) ||
      envelope.version !== 1 || envelope.algorithm !== 'RSA-OAEP-256/A256GCM' ||
      typeof envelope.keyId !== 'string' || !/^[a-f0-9]{64}$/.test(envelope.keyId)) fail('Invalid release manifest.');
  if (base64(envelope.wrappedKey, 1024).length < 384) fail('Invalid wrapped key.');
  base64(manifest.nonce, 12, 12);
  return Buffer.from(JSON.stringify([1, manifest.releaseId, manifest.bytes, manifest.sha256,
    envelope.version, envelope.algorithm, envelope.keyId, envelope.wrappedKey, manifest.nonce]));
}

/** Authenticate metadata before trusting its release identity, digest, or decryption parameters. */
export function verifyReleaseManifest(manifest, encodedKey, expectedReleaseId) {
  const payload = releaseManifestPayload(manifest);
  const actual = base64(manifest.authentication, 32, 32);
  const expected = createHmac('sha256', authenticationKey(encodedKey)).update(payload).digest();
  if (!timingSafeEqual(actual, expected)) fail('Release manifest authentication failed.');
  if (expectedReleaseId !== undefined && manifest.releaseId !== expectedReleaseId) fail('Release identity mismatch.');
}

/** Verify the complete encrypted escrow before storing or decrypting it. */
export function verifyReleaseArtifact(manifest, artifact, encodedKey, expectedReleaseId) {
  verifyReleaseManifest(manifest, encodedKey, expectedReleaseId);
  if (artifact.byteLength !== manifest.bytes || digest(artifact) !== manifest.sha256) fail('Release artifact integrity failed.');
}

async function privateOutput(directory, write) {
  // Refuse existing directories, even empty ones: no old files or symlinks can enter the extraction.
  await mkdir(directory, { mode: 0o700 });
  try { await write(); }
  catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}

/** Seal every explicitly listed file. Sources resolve relative to the input manifest. */
export async function sealRelease({ inputPath, kitPath, outputDirectory }) {
  const input = parseJson(await readBounded(inputPath, MAX_METADATA_BYTES));
  if (!isObject(input) || input.version !== 1 || !isObject(input.files)) fail('Invalid release input manifest.');
  releaseId(input.releaseId);
  const paths = Object.keys(input.files).toSorted();
  validateArchivePaths(paths);
  const kit = await readKit(kitPath);
  const kitRealPath = await realpath(kitPath);
  let total = 0;
  const files = [];
  for (const path of paths) {
    const source = input.files[path];
    if (typeof source !== 'string' || !source) fail('Every archive file requires a source.');
    const sourcePath = resolve(dirname(inputPath), source);
    if (await realpath(sourcePath) === kitRealPath) fail('Recovery kit cannot enter release escrow.');
    const bytes = await readBounded(sourcePath, MAX_INPUT_BYTES - total);
    if (bytes.includes(Buffer.from(kit.privateKey.d))) fail('Recovery private key cannot enter release escrow.');
    total += bytes.length;
    files.push({ path, bytes: bytes.length, data: bytes.toString('base64') });
  }
  const archive = Buffer.from(JSON.stringify({ version: 1, releaseId: input.releaseId, files }));
  if (archive.length > MAX_ARTIFACT_BYTES) fail('Release archive exceeds the size limit.');
  const compressed = gzipSync(archive);
  const key = randomBytes(32);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(JSON.stringify([1, input.releaseId])));
  const artifact = Buffer.concat([cipher.update(compressed), cipher.final(), cipher.getAuthTag()]);
  const manifest = { version: 1, releaseId: input.releaseId, bytes: artifact.length, sha256: digest(artifact),
    keyEnvelope: { version: 1, algorithm: 'RSA-OAEP-256/A256GCM', keyId: keyId(kit.publicKey),
      wrappedKey: publicEncrypt({ key: kit.publicKeyObject, padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256' }, key).toString('base64') }, nonce: nonce.toString('base64') };
  key.fill(0);
  manifest.authentication = createHmac('sha256', authenticationKey(kit.authenticationKey))
    .update(releaseManifestPayload(manifest)).digest('base64');
  await privateOutput(outputDirectory, async () => {
    await writePrivate(join(outputDirectory, 'artifact.bin'), artifact);
    await writePrivate(join(outputDirectory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  });
  return manifest;
}

async function writePrivate(path, bytes) {
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(bytes); } finally { await handle.close(); }
}

/** Verify, decrypt, validate all paths, then extract into a newly created private directory. */
export async function openRelease({ manifestPath, artifactPath, kitPath, outputDirectory, expectedReleaseId }) {
  const kit = await readKit(kitPath);
  const manifest = parseJson(await readBounded(manifestPath, 16 * 1024));
  verifyReleaseManifest(manifest, kit.authenticationKey, expectedReleaseId);
  const artifact = await readBounded(artifactPath, MAX_ARTIFACT_BYTES);
  verifyReleaseArtifact(manifest, artifact, kit.authenticationKey, expectedReleaseId);
  if (keyId(kit.publicKey) !== manifest.keyEnvelope.keyId) fail('Recovery key does not match release.');
  const key = privateDecrypt({ key: kit.privateKeyObject, padding: constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: 'sha256' }, base64(manifest.keyEnvelope.wrappedKey, 1024));
  let compressed;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, base64(manifest.nonce, 12, 12));
    decipher.setAAD(Buffer.from(JSON.stringify([1, manifest.releaseId])));
    decipher.setAuthTag(artifact.subarray(-16));
    compressed = Buffer.concat([decipher.update(artifact.subarray(0, -16)), decipher.final()]);
  } finally { key.fill(0); }
  const archive = parseJson(gunzipSync(compressed, { maxOutputLength: MAX_ARTIFACT_BYTES }));
  if (!isObject(archive) || archive.version !== 1 || archive.releaseId !== manifest.releaseId ||
      !Array.isArray(archive.files)) fail('Invalid release archive.');
  validateArchivePaths(archive.files.map((file) => file?.path));
  let total = 0;
  const files = archive.files.map((file) => {
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > MAX_INPUT_BYTES - total) fail('Invalid archive file size.');
    const data = base64(file.data, MAX_INPUT_BYTES - total, file.bytes);
    total += data.length;
    return { path: file.path, data };
  });
  await privateOutput(outputDirectory, async () => {
    for (const file of files) {
      const path = join(outputDirectory, file.path);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writePrivate(path, file.data);
    }
  });
  return { releaseId: manifest.releaseId, files: files.length, bytes: total };
}

/** Parse the deliberately small CLI surface without printing secret-bearing input or exceptions. */
export async function runCli(command, args) {
  const flags = {};
  const allowed = command === 'seal-release' ? ['--input', '--kit', '--out'] :
    ['--manifest', '--artifact', '--kit', '--out', '--release-id'];
  for (let i = 0; i < args.length; i += 2) {
    if (!allowed.includes(args[i]) || flags[args[i]] || !args[i + 1] || args[i + 1].startsWith('--')) fail('Invalid command arguments.');
    flags[args[i]] = args[i + 1];
  }
  if (allowed.filter((flag) => flag !== '--release-id').some((flag) => !flags[flag])) fail('Missing command arguments.');
  if (command === 'seal-release') await sealRelease({ inputPath: flags['--input'], kitPath: flags['--kit'], outputDirectory: flags['--out'] });
  else await openRelease({ manifestPath: flags['--manifest'], artifactPath: flags['--artifact'], kitPath: flags['--kit'],
    outputDirectory: flags['--out'], expectedReleaseId: flags['--release-id'] });
}
