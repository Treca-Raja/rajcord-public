import { createServer, type Socket } from 'node:net';
import { connect } from 'node:tls';

// libnice's RFC5245 transport implements TURN/TCP. Keep that socket on
// loopback and send its TURN stream over hostname-verified TLS off-host.
export async function openTurnTls(host: string, port: number) {
  const sockets = new Set<Socket>();
  const server = createServer({ pauseOnConnect: true }, (local) => {
    if (sockets.size >= 12) {
      local.destroy();
      return;
    }
    const remote = connect({
      host,
      port,
      servername: host,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
    });
    sockets.add(local);
    sockets.add(remote);
    const close = () => {
      local.destroy();
      remote.destroy();
      sockets.delete(local);
      sockets.delete(remote);
    };
    const handshake = setTimeout(close, 5000);
    handshake.unref();
    remote.once('secureConnect', () => {
      clearTimeout(handshake);
      local.pipe(remote).pipe(local);
      local.resume();
    });
    for (const socket of [local, remote]) {
      socket.on('error', close);
      socket.once('close', () => {
        clearTimeout(handshake);
        close();
      });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  server.unref();
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Could not open the local OBS TURN/TLS transport.');
  }
  return {
    port: address.port,
    close() {
      server.close();
      for (const socket of sockets) socket.destroy();
    },
  };
}
