import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { connect } from 'node:net';
import { once } from 'node:events';
import { openTurnTls } from '../apps/desktop/dist/obs-turn-tls.js';

const wrongHost = process.argv.includes('--wrong-host');
const untrusted = process.argv.includes('--untrusted');
const tunnel = await openTurnTls(wrongHost ? '127.0.0.1' : 'localhost', 5350);
const connection = connect(tunnel.port, '127.0.0.1');
const bytes = [];
let timeout;
try {
  await once(connection, 'connect');
  const binding = Buffer.alloc(20);
  binding.writeUInt16BE(1);
  binding.writeUInt32BE(0x2112a442, 4);
  randomBytes(12).copy(binding, 8);
  const result = await new Promise((resolve, reject) => {
    timeout = setTimeout(() => reject(new Error('Local TLS control test timed out.')), 6500);
    connection.on('data', (data) => {
      bytes.push(data);
      const received = Buffer.concat(bytes);
      if (received.length >= 20 && received.length >= 20 + received.readUInt16BE(2))
        resolve(received);
    });
    connection.once('close', () => resolve(Buffer.concat(bytes)));
    connection.once('error', (error) => {
      if ((wrongHost || untrusted) && error.code === 'ECONNRESET') resolve(Buffer.concat(bytes));
      else reject(error);
    });
    connection.write(binding);
  });
  if (wrongHost || untrusted) assert.equal(result.length, 0);
  else {
    assert.equal(result.readUInt16BE(), 0x0101);
    assert.deepEqual(result.subarray(4, 20), binding.subarray(4, 20));
  }
  console.log(
    wrongHost
      ? 'PASS TLS wrong hostname rejected'
      : untrusted
        ? 'PASS TLS untrusted certificate rejected'
        : 'PASS certificate-verified TLS STUN binding',
  );
} finally {
  clearTimeout(timeout);
  connection.destroy();
  tunnel.close();
}
