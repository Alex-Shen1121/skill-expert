import { createHash } from 'node:crypto';

function recoveryPlanFields(record) {
  return {
    commonDir: record.commonDir,
    primaryWorktree: record.primaryWorktree,
    oldMainSha: record.oldMainSha,
    targetRemoteSha: record.targetRemoteSha,
    remoteRef: record.remoteRef,
    recoveryBranch: record.recoveryBranch,
    trackedChanges: record.trackedChanges ?? {
      staged: record.stagedBefore,
      unstaged: record.unstagedBefore,
      paths: record.trackedPaths,
    },
    trackedContentDigest: record.trackedContentDigest,
    untrackedPaths: record.untrackedPaths ?? record.untrackedBefore,
    untrackedState: record.untrackedState ?? record.untrackedStateBefore,
    snapshotLimitation: record.snapshotLimitation,
  };
}

export function calculateRecoveryPlanId(record) {
  return createHash('sha256')
    .update(JSON.stringify(recoveryPlanFields(record)))
    .digest('hex');
}
