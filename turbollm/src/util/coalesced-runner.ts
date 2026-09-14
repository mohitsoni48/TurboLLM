/**
 * Runs one async task with single-flight plus one shared trailing execution.
 *
 * Contract (each clause is pinned by coalesced-runner.test.ts):
 *  C1  never two executions of `task` at once;
 *  C2  a request() resolves only after an execution that STARTED at or after that request has
 *      completed, so the caller never sees a result older than its own request;
 *  C3  every request() made while an execution runs shares ONE follow-up execution;
 *  C4  request() never rejects: a thrown or rejected task goes to `onError` once and the request
 *      still resolves; the next request() runs the task again.
 *
 * Consumer: Scanner.rescan(), whose old drop-while-busy guard let a request resolve against a
 * library walked before the request was made (ADR-425).
 */
export class CoalescedRunner {
  private currentExecution: Promise<void> | null = null
  private followUp: Promise<void> | null = null

  constructor(
    private readonly task: () => Promise<void>,
    private readonly onError: (err: unknown) => void,
  ) {}

  request(): Promise<void> {
    if (this.followUp) return this.followUp
    if (this.currentExecution) return this.queueFollowUp(this.currentExecution)
    return this.startExecution()
  }

  /** True from the first request until the last queued execution has finished. */
  get busy(): boolean {
    return this.currentExecution !== null || this.followUp !== null
  }

  private queueFollowUp(current: Promise<void>): Promise<void> {
    this.followUp = current.then(() => this.startExecution())
    return this.followUp
  }

  private startExecution(): Promise<void> {
    this.followUp = null
    const execution = this.runTaskReportingErrors()
    this.currentExecution = execution
    void execution.then(() => this.forgetIfCurrent(execution))
    return execution
  }

  private async runTaskReportingErrors(): Promise<void> {
    try {
      await this.task()
    } catch (err) {
      this.reportError(err)
    }
  }

  private reportError(err: unknown): void {
    try {
      this.onError(err)
    } catch {
      // A throwing onError must not escape: request() never rejects (C4).
    }
  }

  private forgetIfCurrent(execution: Promise<void>): void {
    if (this.currentExecution === execution) this.currentExecution = null
  }
}
