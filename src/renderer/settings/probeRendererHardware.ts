import type { HardwareProbeResult, RendererHardwareDiagnostics } from '../../shared/hardware-diagnostics';

const software = (name: string) => /swiftshader|llvmpipe|lavapipe|softpipe|software raster/i.test(name);
const unavailable = (detail?: string): HardwareProbeResult => ({ status: 'unavailable', reason: 'probe-failed', ...(detail ? { detail } : {}) });
function webgl(): RendererHardwareDiagnostics['webgl'] {
  let gl: WebGL2RenderingContext | null = null;
  try {
    const canvas = document.createElement('canvas'); canvas.width = 4; canvas.height = 4;
    gl = canvas.getContext('webgl2');
    if (!gl) return { ...unavailable(), renderer: null };
    gl.clearColor(.25, .5, .75, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    const pixel = new Uint8Array(4); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    const [red = 0, green = 0, blue = 0, alpha = 0] = pixel;
    if (gl.getError() !== gl.NO_ERROR || alpha !== 255 || Math.abs(red - 64) > 2
      || Math.abs(green - 128) > 2 || Math.abs(blue - 191) > 2) return { ...unavailable(), renderer: null };
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = String(gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
    return { status: software(renderer) ? 'software' : 'available', reason: null, renderer };
  } catch (error) { return { ...unavailable(String(error)), renderer: null }; }
  finally { gl?.getExtension('WEBGL_lose_context')?.loseContext(); }
}
async function webgpu(): Promise<RendererHardwareDiagnostics['webgpu']> {
  let device: GPUDevice | undefined;
  let source: GPUBuffer | undefined, dest: GPUBuffer | undefined;
  try {
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) return { status: 'unavailable', reason: 'unsupported', renderer: null };
    device = await adapter.requestDevice();
    source = device.createBuffer({ size: 8, usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    dest = device.createBuffer({ size: 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    device.queue.writeBuffer(source, 0, new Uint32Array([0x11223344, 0x55667788]));
    const encoder = device.createCommandEncoder(); encoder.copyBufferToBuffer(source, 0, dest, 0, 8);
    device.queue.submit([encoder.finish()]); await dest.mapAsync(GPUMapMode.READ);
    const values = new Uint32Array(dest.getMappedRange());
    const ok = values[0] === 0x11223344 && values[1] === 0x55667788;
    dest.unmap();
    const renderer = adapter.info.description || [adapter.info.vendor, adapter.info.device].filter(Boolean).join(' ') || null;
    return { status: ok ? adapter.info.isFallbackAdapter || renderer && software(renderer) ? 'software' : 'available' : 'unavailable',
      reason: ok ? null : 'probe-failed', renderer };
  } catch (error) { return { ...unavailable(String(error)), renderer: null }; }
  finally { source?.destroy(); dest?.destroy(); device?.destroy(); }
}
let gpuTask: ReturnType<typeof webgpu> | undefined;
/** The timeout only stops waiting. A late task still destroys its device and is shared until it drains. */
export async function probeRendererHardware(): Promise<RendererHardwareDiagnostics> {
  const gl = webgl();
  gpuTask ??= webgpu().finally(() => { gpuTask = undefined; });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const gpu = await Promise.race([gpuTask, new Promise<RendererHardwareDiagnostics['webgpu']>(resolve => {
      timer = setTimeout(() => resolve({ status: 'unavailable', reason: 'timeout', renderer: null }), 5000);
    })]);
    return { webgl: gl, webgpu: gpu };
  } finally { clearTimeout(timer); }
}
