// Tracks what happened to each record in a run, so staff can see what came
// through and what didn't.

export class RunSummary {
  /** @param {string} source */
  constructor(source) {
    this.source = source;
    this.startedAt = new Date().toISOString();
    this.finishedAt = null;
    this.imported = 0;
    /** @type {{ ref: string, reasons: string[] }[]} */
    this.rejected = [];
    /** @type {{ ref: string, error: string }[]} */
    this.failed = [];
  }

  recordImported() {
    this.imported++;
  }

  /**
   * The record was not sent because it failed mapping or validation.
   * @param {string} ref
   * @param {string[]} reasons
   */
  recordRejected(ref, reasons) {
    this.rejected.push({ ref, reasons });
  }

  /**
   * The record was valid but sending it to the CRM failed.
   * @param {string} ref
   * @param {string} error
   */
  recordFailed(ref, error) {
    this.failed.push({ ref, error });
  }

  finish() {
    this.finishedAt = new Date().toISOString();
    return this;
  }

  get total() {
    return this.imported + this.rejected.length + this.failed.length;
  }

  toJSON() {
    return {
      source: this.source,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      total: this.total,
      imported: this.imported,
      rejected: this.rejected,
      failed: this.failed,
    };
  }

  toText() {
    const lines = [
      `Source:   ${this.source}`,
      `Records:  ${this.total}`,
      `Imported: ${this.imported}`,
      `Rejected: ${this.rejected.length}`,
      `Failed:   ${this.failed.length}`,
    ];
    for (const { ref, reasons } of this.rejected) lines.push(`  rejected ${ref}: ${reasons.join('; ')}`);
    for (const { ref, error } of this.failed) lines.push(`  failed   ${ref}: ${error}`);
    return lines.join('\n');
  }
}
