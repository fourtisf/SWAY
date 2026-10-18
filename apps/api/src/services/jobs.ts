/**
 * Jobs the API hands to the workers. Contract with apps/workers:
 *   queue `x-jobs`, job name `verify-task`, payload VerifyTaskJob { userId, taskId, day: 'YYYY-MM-DD' }.
 * The worker verifies on X (with the app bearer token or a stored budget), writes TaskCompletion +
 * PointsLedger (ref `task:<taskId>:<day>`) and the 'points' notification.
 *   job `refresh-score`, payload { userId }: rescore a member from public X data (queued when the X budget
 *   runs out while reading a returning member's posts at sign-in).
 */
import { Queue } from 'bullmq';
import type { TaskId } from '@sway/shared';

export const X_JOBS_QUEUE = 'x-jobs';
export const VERIFY_TASK_JOB = 'verify-task';
export const REFRESH_SCORE_JOB = 'refresh-score';

export interface VerifyTaskJob {
  userId: string;
  taskId: TaskId;
  /** UTC day, YYYY-MM-DD (1970-01-01 for one-off tasks). */
  day: string;
}

export interface JobQueue {
  enqueueVerifyTask(job: VerifyTaskJob): Promise<void>;
  enqueueRefreshScore(userId: string): Promise<void>;
  close(): Promise<void>;
}

export class BullJobQueue implements JobQueue {
  private readonly queue: Queue;

  constructor(redisUrl: string) {
    // BullMQ needs its own connection with maxRetriesPerRequest null.
    this.queue = new Queue(X_JOBS_QUEUE, { connection: { url: redisUrl, maxRetriesPerRequest: null } });
  }

  async enqueueVerifyTask(job: VerifyTaskJob): Promise<void> {
    await this.queue.add(VERIFY_TASK_JOB, job, {
      // One live job per task-day; custom ids cannot contain ':'.
      jobId: `verify-task__${job.userId}__${job.taskId}__${job.day}`,
      attempts: 5,
      backoff: { type: 'exponential', delay: 60_000 },
      removeOnComplete: true,
      removeOnFail: true,
    });
  }

  async enqueueRefreshScore(userId: string): Promise<void> {
    await this.queue.add(
      REFRESH_SCORE_JOB,
      { userId },
      {
        jobId: `refresh-score__${userId}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 15 * 60_000 },
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}

/** In-memory queue for tests and scripts. */
export class MemoryJobQueue implements JobQueue {
  readonly jobs: VerifyTaskJob[] = [];
  readonly refreshes: string[] = [];
  async enqueueVerifyTask(job: VerifyTaskJob): Promise<void> {
    this.jobs.push(job);
  }
  async enqueueRefreshScore(userId: string): Promise<void> {
    this.refreshes.push(userId);
  }
  async close(): Promise<void> {}
}
