import { Component } from '@angular/core';
import { JobsService, JobDefinition } from '../services/jobs.service';

@Component({
  selector: 'app-jobs-runner',
  template: `
    <div style="padding:12px">
      <h2>Jobs Runner</h2>
      <div style="margin:12px 0">
        <label>Start URL</label>
        <input style="width:60%" [(ngModel)]="startUrl" />
        <button (click)="run()" style="margin-left:8px">Run</button>
      </div>
      <div *ngIf="runId">Run: {{ runId }} | Status: {{ status }}</div>
      <div *ngIf="rows?.length">
        <h3>Rows ({{ rows.length }})</h3>
        <pre style="max-height:40vh; overflow:auto; background:#f7f7f7; padding:8px">{{ rows | json }}</pre>
      </div>
    </div>
  `,
})
export class JobsRunnerComponent {
  startUrl = 'https://example.com/';
  runId: string | null = null;
  status = '';
  rows: any[] = [];
  timer: any;

  constructor(private jobs: JobsService) {}

  run() {
    const job: JobDefinition = {
      startUrls: [this.startUrl],
      list: { itemSelector: 'a', linkSelector: null, fields: { Title: 'h1' } },
      detail: { fields: { Title: 'h1', Hyperlink: 'a[href]' } },
      behavior: { headless: true, timeout: 60000, waitUntil: 'domcontentloaded' },
    };
    this.jobs.run(job).subscribe((resp) => {
      this.runId = resp.runId;
      this.status = 'queued';
      this.rows = [];
      this.poll();
    });
  }

  poll() {
    if (!this.runId) return;
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      if (!this.runId) return;
      this.jobs.status(this.runId).subscribe((s) => {
        this.status = s.status;
        if (s.status === 'done' || s.status === 'failed') {
          clearInterval(this.timer);
          if (s.status === 'done') {
            this.jobs.result(this.runId!).subscribe((r) => (this.rows = r.rows || []));
          }
        }
      });
    }, 1000);
  }
}

