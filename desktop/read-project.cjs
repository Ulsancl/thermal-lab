async function readProjectBytes(handle, maximum) {
  const buffer = Buffer.allocUnsafe(maximum + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) return buffer.subarray(0, offset);
    offset += bytesRead;
  }
  throw new Error('실험 파일은 1 MiB 이하여야 합니다.');
}

module.exports = { readProjectBytes };
