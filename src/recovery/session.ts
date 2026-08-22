// B3-3 recovery boundaries (#372): session checkpoint / resume strategy.
//
// Checkpoint ON_TOOL_CALL — a snapshot of which steps have completed is
// recorded before every external interaction. On a mid-turn crash the session
// can resume in one of three modes:
//
//   resume_last     — continue from the last checkpoint (no rollback)
//   resume_stable   — roll back to the last clean tool boundary; the steps that
//                     completed BEFORE that boundary are kept (so their side
//                     effects are NOT re-executed), and only the unfinished
//                     tail is replayed
//   restart_clean   — discard all in-turn progress and start over
//
// Recovery decisions are emitted to the audit trail with a reason class.
export type RecoveryMode = "resume_last" | "resume_stable" | "restart_clean";

/** A recorded checkpoint: the boundary plus the set of completed step ids. */
export interface RecoveryCheckpoint {
  /** Boundary label, e.g. "tool:write_file:<id>". */
  at: string;
  /** Step ids that had completed their side effects at this point. */
  completed: string[];
}

/** What a resume produces: which steps are committed (skip) and whether the
 *  caller must roll back state before replaying. */
export interface ResumePlan {
  mode: RecoveryMode;
  /** Step ids whose side effects are already done — do NOT re-execute them. */
  committed: Set<string>;
  /** Whether the resume implies a state rollback to a checkpoint. */
  rollback: boolean;
  /** The checkpoint boundary the session resumes from (may be null). */
  resumeFrom: RecoveryCheckpoint | null;
}

export class RecoverySession {
  private readonly completed = new Set<string>();
  private readonly checkpoints: RecoveryCheckpoint[] = [];

  constructor(private readonly audit?: (detail: string) => void) {}

  /** Record a checkpoint ON_TOOL_CALL, before the external interaction. */
  checkpoint(boundary: string): void {
    this.checkpoints.push({ at: boundary, completed: [...this.completed] });
    this.audit?.(`reason=checkpoint boundary=${boundary}`);
  }

  /** Mark a step's side effect as durably completed. */
  complete(stepId: string): void {
    if (!this.completed.has(stepId)) {
      this.completed.add(stepId);
      this.audit?.(`reason=complete step=${stepId}`);
    }
  }

  /** Whether a step is already committed (its side effect is done). */
  isCommitted(stepId: string): boolean {
    return this.completed.has(stepId);
  }

  get lastCheckpoint(): RecoveryCheckpoint | null {
    return this.checkpoints.length > 0
      ? this.checkpoints[this.checkpoints.length - 1]!
      : null;
  }

  /**
   * Decide how to resume after a crash. Returns the committed step set so the
   * caller can skip re-executing side effects (the no-duplicate rule).
   */
  resume(mode: RecoveryMode): ResumePlan {
    switch (mode) {
      case "restart_clean":
        this.audit?.("reason=restart_clean");
        return { mode, committed: new Set(), rollback: true, resumeFrom: null };
      case "resume_last": {
        const resumeFrom = this.lastCheckpoint;
        this.audit?.("reason=resume_last");
        return {
          mode,
          committed: new Set(this.completed),
          rollback: false,
          resumeFrom,
        };
      }
      case "resume_stable": {
        const resumeFrom = this.lastCheckpoint;
        // Roll back to the last clean boundary and keep only the steps that had
        // completed BEFORE it — everything after is replayed exactly once.
        const committed = new Set(resumeFrom?.completed ?? []);
        this.audit?.(
          `reason=resume_stable committed=${[...committed].join(",") || "(none)"}`,
        );
        return { mode, committed, rollback: true, resumeFrom };
      }
    }
  }
}
