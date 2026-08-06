/**
 * Shared qlog Cap'n Proto event iterator.
 * Union tags verified for this dataset (bundled @commaai/log_reader schema):
 *   20 = gpsLocation
 *   47 = gpsLocationExternal
 *   73 = modelV2
 */
const fs = require('fs');
const capnp = require('capnp-ts');
const Log = require('@commaai/log_reader/capnp/log.capnp');
const { readSize } = require('@commaai/log_reader/src/buffer');

const UNION = {
  GPS_LOCATION: 20,
  GPS_LOCATION_EXTERNAL: 47,
  MODEL_V2: 73,
};

function* iterateEvents(buf, sourceFile = '') {
  let pos = 0;
  let sourceEventIndex = 0;

  while (pos < buf.length) {
    const remaining = buf.slice(pos);
    const size = readSize(remaining);
    if (!size || size > remaining.length) break;

    const msgBuf = remaining.slice(0, size);
    pos += size;

    const msg = new capnp.Message(msgBuf, false);
    const event = msg.getRoot(Log.Event);
    const unionTag = capnp.Struct.getUint16(8, event);

    yield {
      event,
      unionTag,
      logMonoTime: event.getLogMonoTime(),
      valid: event.getValid(),
      sourceFile,
      sourceEventIndex,
    };
    sourceEventIndex++;
  }
}

function iterateEventsFromFile(filePath) {
  const buf = fs.readFileSync(filePath);
  const sourceFile = require('path').basename(filePath);
  return iterateEvents(buf, sourceFile);
}

function getGpsLocation(event) {
  return capnp.Struct.getStruct(0, Log.GpsLocationData, event);
}

function getModelV2(event) {
  return capnp.Struct.getStruct(0, Log.ModelDataV2, event);
}

module.exports = {
  Log,
  UNION,
  iterateEvents,
  iterateEventsFromFile,
  getGpsLocation,
  getModelV2,
};
