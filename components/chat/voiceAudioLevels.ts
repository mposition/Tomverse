/** Visual meter only. GPT-Live remains responsible for speech detection and interruption. */
export function monitorVoiceAudioLevels(stream: MediaStream, onLevel: (level: number) => void) {
  let context: AudioContext;
  try { context = new AudioContext(); } catch { return () => {}; }
  const analyser = context.createAnalyser(); analyser.fftSize = 256;
  let source: MediaStreamAudioSourceNode;
  try { source = context.createMediaStreamSource(stream); source.connect(analyser); }
  catch { void context.close().catch(() => {}); return () => {}; }
  const samples = new Uint8Array(analyser.fftSize);
  void context.resume().catch(() => {});
  const timer = setInterval(() => {
    analyser.getByteTimeDomainData(samples);
    const rms = Math.sqrt(samples.reduce((sum, value) => sum + ((value - 128) / 128) ** 2, 0) / samples.length);
    onLevel(Math.min(1, rms * 4));
  }, 100);
  return () => { clearInterval(timer); source.disconnect(); analyser.disconnect(); void context.close().catch(() => {}); };
}
