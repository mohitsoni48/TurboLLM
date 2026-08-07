// Emits REAL llama.cpp error text so classifyLoadFailure is exercised against
// actual strings rather than invented ones.
const mode = process.env.FIXTURE_MODE ?? 'happy'
const TEXT = {
  oom: 'ggml_backend_cuda_buffer_type_alloc_buffer: allocating 8192.00 MiB on device 0: cudaMalloc failed: out of memory',
  unsupported_arch: 'llama_model_load: error loading model: unknown model architecture: \'somearch\'',
}
if (TEXT[mode]) { process.stderr.write(TEXT[mode] + '\n'); process.exit(1) }
// Happy path: pretend to be a ready server so readiness probing succeeds.
process.stdout.write('main: server is listening on 127.0.0.1:8081\n')
setInterval(() => {}, 1 << 30)
