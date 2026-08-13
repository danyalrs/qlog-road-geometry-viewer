'use strict';
/**
 * Extract synchronized video frames for every outer-line (L0/L3) diagnosis
 * case, so each can be individually reviewed. Also produces a CSV/JSON review
 * table with all recorded signals per case.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'reports', 'outer_line_diagnosis');
const DATA = require(path.join(OUT, 'diagnosis_set.json'));

function videoPath(seg) { return path.join(ROOT, `f449c322f59e6943---2026-07-20--09-34-13--${seg}---qcamera.ts`); }

function main() {
  fs.mkdirSync(path.join(OUT, 'frames'), { recursive: true });
  const rows = [];
  const MIN_SUPPORT = 5;
  for (const [f, o] of Object.entries(DATA)) {
    for (const li of [0, 3]) {
      const lane = o.lanes[li];
      if (!lane || lane.n < MIN_SUPPORT) continue;
      const side = li === 0 ? 'L0' : 'L3';
      const vf = o.repVideoFrame?.frameIndex;
      const png = vf != null ? path.join(OUT, 'frames', `seg${o.seg}_${side}_frame${vf}.png`) : null;
      if (png && !fs.existsSync(png)) {
        try {
          execFileSync('ffmpeg', ['-v', 'error', '-i', videoPath(o.seg), '-vf', `select='eq(n,${vf})'`, '-frames:v', '1', '-y', png], { maxBuffer: 20 * 1024 * 1024 });
        } catch (e) {
          console.log('frame extract fail seg', o.seg, side, e.message.split('\n')[0]);
        }
      }
      rows.push({
        segmentId: o.seg,
        outer: side,
        timelineIdx: o.repTimelineIdx,
        frameId: o.repFrameId,
        videoFrameIndex: vf,
        syncErrMs: o.repVideoFrame?.errMs ?? null,
        laneLineProb: lane.meanProb,
        laneLineStd: lane.meanStd,
        temporalSupportFrames: lane.n,
        lateralFromEgoM: lane.meanY, // signed; ego boundary L1/L2 is ~1.5-1.8
        rightEdgeY: o.rightEdgeY,
        leftEdgeY: o.leftEdgeY,
        oppositeOuterSupport: side === 'L0' ? (o.lanes[3]?.n ?? 0) : (o.lanes[0]?.n ?? 0),
        candidateDLane1Sections: o.candidateD?.lane1 ?? 0,
        candidateDLane2Sections: o.candidateD?.lane2 ?? 0,
        framePath: png,
        visualMarking: 'PENDING_REVIEW', // filled by manual review
        proposedPhysicalClass: 'unclassified',
      });
    }
  }
  fs.writeFileSync(path.join(OUT, 'outer_line_review_table.json'), JSON.stringify(rows, null, 2));
  console.log('review rows:', rows.length);
  console.log('frames extracted to', path.join(OUT, 'frames'));
}
main();
