import { Component } from '@angular/core';
import { ResultStoreService } from '../services/result-store.service';
import { ExportService } from '../services/export.service';

@Component({
  selector: 'app-data-exporter',
  template: `
    <div class="card">
      <div class="card-header">Data Exporter</div>
      <div class="card-body">
        <div class="d-flex gap-2 mb-3">
          <button
            class="btn btn-success"
            (click)="export1.downloadJSON(result, 'result.json')"
            [disabled]="!result"
          >
            Export JSON
          </button>
          <button
            class="btn btn-secondary"
            (click)="exportCSV()"
            [disabled]="!hasArrayRows"
          >
            Export CSV
          </button>
          <button
            class="btn btn-primary"
            (click)="exportExcel()"
            [disabled]="!hasArrayRows"
          >
            Export Excel
          </button>
          <button class="btn btn-dark" (click)="print()" [disabled]="!result">
            Print/PDF
          </button>
        </div>
        <div *ngIf="!result" class="form-text">
          No result yet. Run a flow first.
        </div>
        <details *ngIf="result">
          <summary>Preview</summary>
          <pre class="mt-2">{{ result | json }}</pre>
        </details>
      </div>
    </div>
  `,
  standalone: false,
})
export class DataExporterComponent {
  result: any = null;
  hasArrayRows = false;

  constructor(
    private store: ResultStoreService,
    public export1: ExportService,
  ) {
    this.result = this.store.getSnapshot();
    this.hasArrayRows =
      Array.isArray(this.result?.data?.links) &&
      this.result.data.links.length > 0;
  }

  exportCSV() {
    const rows = this.result?.data?.links || [];
    this.export1.downloadCSV(rows, 'result.csv');
  }

  exportExcel() {
    const rows = this.result?.data?.links || [];
    this.export1.downloadExcel(rows, 'result.xlsx');
  }

  print() {
    const html = `<h1>Result</h1><pre>${this.escape(String(JSON.stringify(this.result ?? {}, null, 2)))}</pre>`;
    this.export1.printHtml(html, 'Result');
  }

  private escape(s: string) {
    return s.replace(
      /[&<>]/g,
      (c) => (({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }) as any)[c],
    );
  }
}
