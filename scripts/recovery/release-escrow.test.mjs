import assert from 'node:assert/strict';
import { createCipheriv, createHash, createHmac, generateKeyPairSync, privateDecrypt, constants } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm, stat, access, symlink, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { test } from 'node:test';
import { MAX_INPUT_BYTES, sealRelease, openRelease, validateArchivePaths,
  releaseManifestPayload, verifyReleaseArtifact } from './release-escrow.mjs';

const keys = generateKeyPairSync('rsa', { modulusLength: 3072 });
const kit = { version: 1, publicKey: keys.publicKey.export({ format: 'jwk' }),
  privateKey: keys.privateKey.export({ format: 'jwk' }),
  authenticationKey: Buffer.alloc(32, 42).toString('base64'), capabilityKey: 'offline-capability-key' };

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'release-escrow-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const kitPath = join(directory, 'kit.json');
  const inputPath = join(directory, 'input.json');
  const source = join(directory, 'worker.js');
  await writeFile(kitPath, JSON.stringify(kit), { mode: 0o600 });
  await writeFile(source, 'export default { fetch() { return new Response("ready"); } };');
  await writeFile(join(directory, 'secret.bin'), Buffer.from([0, 1, 2, 255]));
  const input = { version: 1, releaseId: 'release-abc123',
    files: { 'workers/backend.js': 'worker.js', 'private/secret.bin': 'secret.bin' } };
  await writeFile(inputPath, JSON.stringify(input));
  const outputDirectory = join(directory, 'sealed');
  const manifestPath = join(outputDirectory, 'manifest.json');
  const artifactPath = join(outputDirectory, 'artifact.bin');
  return { directory, kitPath, inputPath, source, input, outputDirectory, manifestPath, artifactPath };
}

test('roundtrip preserves binary and compiled files; files and directories stay private', async (t) => {
  const f = await fixture(t);
  const manifest = await sealRelease(f);
  const artifact = await readFile(f.artifactPath);
  verifyReleaseArtifact(manifest, artifact, kit.authenticationKey, f.input.releaseId);
  assert.equal(artifact.includes(Buffer.from(kit.privateKey.d)), false);
  assert.equal(JSON.stringify(manifest).includes('privateKey'), false);
  const outputDirectory = join(f.directory, 'opened');
  const result = await openRelease({ ...f, outputDirectory, expectedReleaseId: f.input.releaseId });
  assert.equal(result.files, 2);
  assert.deepEqual(await readFile(join(outputDirectory, 'private/secret.bin')), Buffer.from([0, 1, 2, 255]));
  assert.deepEqual(await readFile(join(outputDirectory, 'workers/backend.js')), await readFile(f.source));
  for (const path of [f.manifestPath, f.artifactPath, join(outputDirectory, 'private/secret.bin')]) {
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  }
  assert.equal((await stat(outputDirectory)).mode & 0o777, 0o700);
  assert.equal((await stat(join(outputDirectory, 'workers'))).mode & 0o777, 0o700);
  const second = await sealRelease({ ...f, outputDirectory: join(f.directory, 'sealed-again') });
  assert.notEqual(second.nonce, manifest.nonce);
  assert.notEqual(second.keyEnvelope.wrappedKey, manifest.keyEnvelope.wrappedKey);
});

test('manifest fields, ciphertext, authentication key, and expected release are authenticated', async (t) => {
  const f = await fixture(t);
  const manifest = await sealRelease(f);
  const artifact = await readFile(f.artifactPath);
  for (const field of ['releaseId', 'sha256', 'nonce', 'bytes', 'authentication']) {
    const altered = structuredClone(manifest);
    altered[field] = field === 'bytes' ? altered[field] + 1 : field === 'sha256' ? '0'.repeat(64) :
      field === 'releaseId' ? 'other-release' : Buffer.alloc(field === 'nonce' ? 12 : 32, 23).toString('base64');
    assert.throws(() => verifyReleaseArtifact(altered, artifact, kit.authenticationKey));
  }
  const modified = Buffer.from(artifact);
  modified[0] ^= 1;
  assert.throws(() => verifyReleaseArtifact(manifest, modified, kit.authenticationKey), /integrity/);
  assert.throws(() => verifyReleaseArtifact(manifest, artifact, Buffer.alloc(32).toString('base64')), /authentication/);
  assert.throws(() => verifyReleaseArtifact(manifest, artifact, kit.authenticationKey, 'other-release'), /identity/);
  await writeFile(f.artifactPath, modified);
  const outputDirectory = join(f.directory, 'opened');
  await assert.rejects(openRelease({ ...f, outputDirectory }), /integrity/);
  await assert.rejects(access(outputDirectory));
});

test('unsafe and colliding archive paths are rejected', () => {
  for (const path of ['../escape', '/absolute', 'x/../escape', './file', 'x//y', 'x\\y', 'C:/file',
    'file.', 'NUL.txt', 'x/CON', 'x\u0000y', '']) {
    assert.throws(() => validateArchivePaths([path]), /path/);
  }
  for (const paths of [['a', 'a'], ['A', 'a'], ['a', 'a/b'], ['a/b', 'a']]) {
    assert.throws(() => validateArchivePaths(paths), /collision/);
  }
  assert.doesNotThrow(() => validateArchivePaths(['workers/index.js', 'frontend/_headers', 'private/app-secrets.json']));
});

test('authenticated malicious archive paths fail before extraction', async (t) => {
  const f = await fixture(t);
  const manifest = await sealRelease(f);
  const key = privateDecrypt({ key: keys.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: 'sha256' }, Buffer.from(manifest.keyEnvelope.wrappedKey, 'base64'));
  const cipher = createCipheriv('aes-256-gcm', key, Buffer.from(manifest.nonce, 'base64'));
  cipher.setAAD(Buffer.from(JSON.stringify([1, manifest.releaseId])));
  const archive = gzipSync(Buffer.from(JSON.stringify({ version: 1, releaseId: manifest.releaseId,
    files: [{ path: '../escape', bytes: 1, data: 'YQ==' }] })));
  const artifact = Buffer.concat([cipher.update(archive), cipher.final(), cipher.getAuthTag()]);
  manifest.bytes = artifact.length;
  manifest.sha256 = createHash('sha256').update(artifact).digest('hex');
  manifest.authentication = createHmac('sha256', Buffer.from(kit.authenticationKey, 'base64'))
    .update(releaseManifestPayload(manifest)).digest('base64');
  await writeFile(f.manifestPath, JSON.stringify(manifest));
  await writeFile(f.artifactPath, artifact);
  const outputDirectory = join(f.directory, 'opened');
  await assert.rejects(openRelease({ ...f, outputDirectory }), /path/);
  await assert.rejects(access(outputDirectory));
  await assert.rejects(access(join(f.directory, 'escape')));
});

test('required missing files, symlinks, oversized inputs, and recovery material fail closed', async (t) => {
  const f = await fixture(t);
  await symlink(f.source, join(f.directory, 'link.js'));
  await writeFile(join(f.directory, 'large.bin'), '');
  await truncate(join(f.directory, 'large.bin'), MAX_INPUT_BYTES + 1);
  await writeFile(join(f.directory, 'copy.json'), JSON.stringify(kit));
  for (const source of ['missing.js', 'link.js', 'large.bin', 'kit.json', 'copy.json']) {
    await writeFile(f.inputPath, JSON.stringify({ ...f.input, files: { 'file': source } }));
    await assert.rejects(sealRelease(f));
    await assert.rejects(access(f.outputDirectory));
  }
});

test('existing output directories are never overwritten', async (t) => {
  const f = await fixture(t);
  await sealRelease(f);
  const original = await readFile(f.artifactPath);
  await assert.rejects(sealRelease(f), /EEXIST/);
  assert.deepEqual(await readFile(f.artifactPath), original);
  await assert.rejects(openRelease({ ...f, outputDirectory: f.directory }), /EEXIST/);
  assert.deepEqual(await readFile(f.artifactPath), original);
});
