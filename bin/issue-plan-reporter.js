export default class IssuePlanReporter {
  constructor() {
    this.result = { total: 0, passed: 0, failed: 0, skipped: 0 };
  }

  onStepEnd(_test, _result, step) {
    if (step.error && /^issue-step-\d+$/u.test(step.title)) {
      this.result.failedStep = Number(step.title.slice("issue-step-".length));
    }
  }

  onTestEnd(_test, result) {
    this.result.total += 1;
    if (result.status === "passed") { this.result.passed += 1; }
    else if (result.status === "skipped") { this.result.skipped += 1; }
    else {
      this.result.failed += 1;
      if (!this.result.failedStep) { this.result.blocker = "fixture-or-setup"; }
    }
  }

  onError() { this.result.blocker = "configuration-or-runner"; }

  onEnd() {
    console.log(`FIXLAB_ISSUE_RESULT|${JSON.stringify(this.result)}`);
  }
}
