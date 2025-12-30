const net = require('net');

/**
 * Find an available port starting from the given port
 * @param {number} startPort - Port to start scanning from
 * @returns {Promise<number>} - Available port
 */
async function findAvailablePort(startPort = 41917) {
  const isPortAvailable = (port) => {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => {
        server.close();
        resolve(true);
      });
      server.listen(port);
    });
  };

  let port = startPort;
  while (!(await isPortAvailable(port))) {
    port++;
    if (port > startPort + 100) {
      throw new Error('Could not find available port after 100 attempts');
    }
  }
  return port;
}

module.exports = { findAvailablePort };
