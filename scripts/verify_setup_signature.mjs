import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';

function decodeMinisign(value) {
  return Buffer.from(value.trim(), 'base64').toString('utf8').trim().split(/\r?\n/);
}

function verifySetupSignature(installer, encodedPublicKey) {
  const [, publicPacketText = ''] = decodeMinisign(encodedPublicKey);
  const publicPacket = Buffer.from(publicPacketText, 'base64');
  const [, packetText = '', comment = '', commentSignature = ''] =
    decodeMinisign(readFileSync(installer + '.sig', 'utf8'));
  const packet = Buffer.from(packetText, 'base64');
  if (publicPacket.length !== 42 || packet.length !== 74 ||
      !packet.subarray(2, 10).equals(publicPacket.subarray(2, 10))) {
    throw new Error('Updater signature key does not match this product');
  }

  const algorithm = packet.subarray(0, 2).toString('ascii');
  const commentPrefix = 'trusted comment: ';
  if (!['ED', 'Ed'].includes(algorithm) || !comment.startsWith(commentPrefix)) {
    throw new Error('Invalid updater signature format');
  }

  const publicKey = createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), publicPacket.subarray(10)]),
    format: 'der',
    type: 'spki',
  });
  const bytes = readFileSync(installer);
  const payload = algorithm === 'ED' ? createHash('blake2b512').update(bytes).digest() : bytes;
  const signature = packet.subarray(10);
  const trustedComment = Buffer.from(comment.slice(commentPrefix.length), 'utf8');
  if (!verify(null, payload, publicKey, signature) ||
      !verify(null, Buffer.concat([signature, trustedComment]), publicKey, Buffer.from(commentSignature, 'base64'))) {
    throw new Error('Installer or trusted comment signature verification failed');
  }

  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== readFileSync(installer + '.sha256', 'utf8').trim()) {
    throw new Error('Installer SHA-256 does not match the build checksum');
  }
}

try {
  const [, , installer, configPath] = process.argv;
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  verifySetupSignature(installer, config.plugins.updater.pubkey);
  console.log('Updater signature and installer SHA-256 verified.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
