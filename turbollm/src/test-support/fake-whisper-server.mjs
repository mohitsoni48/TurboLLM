// A stand-in whisper-server for the voice tests: parses --port like the real one, refuses connections for
// FAKE_WHISPER_LOAD_MS (the real one opens its port only after its model is loaded), then answers GET /health.
// FAKE_WHISPER_FAIL=1 prints a whisper-style error and exits with code 3 instead.
import { createServer } from 'node:http'

const args = process.argv.slice(2)
const port = Number(args[args.indexOf('--port') + 1])

if (process.env.FAKE_WHISPER_FAIL === '1') {
  console.error('whisper_init_from_file_with_params_no_state: loading model')
  console.error('error: failed to initialize whisper context')
  process.exit(3)
}

setTimeout(() => {
  createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"status":"ok"}')
    } else {
      res.writeHead(404)
      res.end()
    }
  }).listen(port, '127.0.0.1')
}, Number(process.env.FAKE_WHISPER_LOAD_MS || 0))

process.on('SIGTERM', () => process.exit(0))
