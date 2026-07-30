import http from 'node:http'
import net from 'node:net'

const localPort = Number(process.env.TEST_PUBLIC_TARGET_PORT)

if (Number.isSafeInteger(localPort) && localPort > 0) {
  const defaultCreateConnection = http.Agent.prototype.createConnection
  http.Agent.prototype.createConnection = function (options, callback) {
    if (Number(options.port) !== localPort) {
      return defaultCreateConnection.call(this, options, callback)
    }

    const { lookup: _lookup, ...localOptions } = options
    return net.createConnection({
      ...localOptions,
      host: '127.0.0.1',
      hostname: '127.0.0.1',
    }, callback)
  }
}
