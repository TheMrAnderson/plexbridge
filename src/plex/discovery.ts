import dgram from 'node:dgram';

export const GDM_PORTS = [32410, 32412, 32413, 32414] as const;

export function startDiscovery(name: string, port: number, machineIdentifier: string): dgram.Socket[] {
  const response = Buffer.from(
    `HTTP/1.0 200 OK\r\nName: ${name}\r\nPort: ${port}\r\nResource-Identifier: ${machineIdentifier}\r\nProtocol: plex\r\n\r\n`
  );
  const sockets: dgram.Socket[] = [];
  for (const discoveryPort of GDM_PORTS) {
    const socket = dgram.createSocket('udp4');
    socket.on('message', (message, remote) => {
      if (message.toString().startsWith('M-SEARCH') || message.toString().includes('HTTP/1.1'))
        socket.send(response, remote.port, remote.address);
    });
    socket.once('listening', () => {
      sockets.push(socket);
      console.info(JSON.stringify({ event: 'discovery_listener_active', port: discoveryPort }));
    });
    socket.once('error', (error) => {
      console.warn(JSON.stringify({ event: 'discovery_unavailable', port: discoveryPort, error: error.message }));
      socket.close();
    });
    socket.bind(discoveryPort, '0.0.0.0');
  }
  return sockets;
}
