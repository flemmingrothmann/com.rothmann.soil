'use strict';

function readZclHeaderLength(frame) {
  if (frame.length < 3) {
    return 0;
  }

  const frameControl = frame.readUInt8(0);
  const manufacturerSpecific = (frameControl & 0x04) !== 0;
  return manufacturerSpecific ? 5 : 3;
}

function decodeTuyaDpValuesFromZclFrame(frame) {
  const headerLen = readZclHeaderLength(frame);
  if (headerLen === 0 || frame.length < headerLen) {
    return { zclHeaderLength: 0, commandId: 0, dpValues: [] };
  }

  const commandId = frame.readUInt8(headerLen - 1);
  let offset = headerLen;

  if (frame.length - offset < 2) {
    return { zclHeaderLength: headerLen, commandId, dpValues: [] };
  }

  const status = frame.readUInt8(offset);
  const transid = frame.readUInt8(offset + 1);
  offset += 2;

  const dpValues = [];
  while (frame.length - offset >= 4) {
    const dp = frame.readUInt8(offset);
    const datatype = frame.readUInt8(offset + 1);
    const len = frame.readUInt16BE(offset + 2);
    offset += 4;

    if (frame.length - offset < len) {
      break;
    }

    const data = frame.subarray(offset, offset + len);
    offset += len;
    dpValues.push({ dp, datatype, data });
  }

  return {
    zclHeaderLength: headerLen,
    commandId,
    status,
    transid,
    dpValues,
  };
}

module.exports = {
  decodeTuyaDpValuesFromZclFrame,
};
