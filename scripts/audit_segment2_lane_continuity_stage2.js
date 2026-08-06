'use strict';

const fs = require('fs');
const path = require('path');
const { runLaneContinuityStage2 } = require('../lib/lane_continuity_stage2');

const OUT = path.join(__dirname, '..', 'audit_segment2_lane_continuity_stage2.json');

function main() {
  const audit = runLaneContinuityStage2();
  fs.writeFileSync(OUT, JSON.stringify(audit, null, 2));
  console.log({
    repaired: audit.repaired,
    unresolved: audit.unresolved,
    laneChecksum: audit.after.laneChecksum,
    fusedBefore: audit.summary.fusedFragmentsBefore,
    fusedAfter: audit.summary.fusedFragmentsAfter,
    cleanedBefore: audit.summary.finalFragmentsBefore,
    cleanedAfter: audit.summary.finalFragmentsAfter,
    unsafeOpen: audit.summary.unsafeGapsStillOpen,
    outsideChanges: audit.summary.outsideChangeCount,
  });
}

main();
