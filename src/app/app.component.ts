// import { Component } from '@angular/core';
// import { ScrapeService } from './scrape.service';

// type FlowKey = 'url' | 'content' | 'strategy' | 'extract' | 'export';

// @Component({
//   selector: 'app-root',
//   template: `
//     <div class="container-fluid py-3">
//       <div class="row">
//         <div class="col-12 col-md-3 col-lg-2 mb-3">
//           <div class="list-group">
//             <button
//               class="list-group-item list-group-item-action"
//               [class.active]="selected === 'url'"
//               (click)="select('url')"
//             >
//               URL Analyzer
//             </button>
//             <button
//               class="list-group-item list-group-item-action"
//               [class.active]="selected === 'content'"
//               (click)="select('content')"
//             >
//               Content Detector
//             </button>
//             <button
//               class="list-group-item list-group-item-action"
//               [class.active]="selected === 'strategy'"
//               (click)="select('strategy')"
//             >
//               Scraping Strategy
//             </button>
//             <button
//               class="list-group-item list-group-item-action"
//               [class.active]="selected === 'extract'"
//               (click)="select('extract')"
//             >
//               Data Extractor
//             </button>
//             <button
//               class="list-group-item list-group-item-action"
//               [class.active]="selected === 'export'"
//               (click)="select('export')"
//             >
//               Data Exporter
//             </button>
//           </div>
//         </div>

//         <div class="col-12 col-md-9 col-lg-10">
//           <div class="card mb-3">
//             <div class="card-body">
//               <div class="d-flex align-items-end gap-2 flex-wrap">
//                 <div class="flex-grow-1">
//                   <label class="form-label">Target URL</label>
//                   <input
//                     class="form-control"
//                     [(ngModel)]="url"
//                     placeholder="https://example.com"
//                   />
//                 </div>
//                 <div>
//                   <label class="form-label d-block">&nbsp;</label>
//                   <button
//                     class="btn btn-primary"
//                     (click)="runSelected()"
//                     [disabled]="loading || !url"
//                   >
//                     Run
//                   </button>
//                 </div>
//               </div>
//               <div class="form-text mt-1">
//                 Current flow: {{ flowLabel(selected) }}
//               </div>
//             </div>
//           </div>

//           <div *ngIf="loading" class="alert alert-info">
//             Running {{ flowLabel(selected) }}...
//           </div>

//           <!-- URL Analyzer -->
//           <div *ngIf="selected === 'url' && result" class="card mb-3">
//             <div class="card-header">URL Analyzer Result</div>
//             <div class="card-body">
//               <div class="row g-3">
//                 <div class="col-12 col-md-6">
//                   <div><strong>Valid:</strong> {{ result.valid }}</div>
//                   <div><strong>Reachable:</strong> {{ result.reachable }}</div>
//                   <div><strong>Status:</strong> {{ result.status }}</div>
//                   <div><strong>Final URL:</strong> {{ result.finalUrl }}</div>
//                 </div>
//                 <div class="col-12 col-md-6">
//                   <div>
//                     <strong>Response Time:</strong>
//                     {{ result.responseTimeMs }} ms
//                   </div>
//                   <div>
//                     <strong>Content-Type:</strong> {{ result.contentType }}
//                   </div>
//                   <div><strong>Server:</strong> {{ result.server }}</div>
//                 </div>
//               </div>
//               <div *ngIf="result.redirects?.length" class="mt-3">
//                 <strong>Redirects:</strong>
//                 <ul>
//                   <li *ngFor="let r of result.redirects">
//                     {{ r.status }} → {{ r.location }}
//                   </li>
//                 </ul>
//               </div>
//               <details *ngIf="result.bodySnippet" class="mt-2">
//                 <summary>Body snippet</summary>
//                 <pre class="mt-2">{{ result.bodySnippet }}</pre>
//               </details>
//             </div>
//           </div>

//           <!-- Content Detector -->
//           <div *ngIf="selected === 'content' && result" class="card mb-3">
//             <div class="card-header">Content Detector Result</div>
//             <div class="card-body">
//               <div class="row g-3">
//                 <div class="col-12 col-md-6">
//                   <div><strong>Title:</strong> {{ result.data?.title }}</div>
//                   <div>
//                     <strong>Heading (h1):</strong>
//                     {{ result.data?.pageHeading }}
//                   </div>
//                   <div>
//                     <strong>Content Type:</strong>
//                     {{ result.data?.contentType }}
//                   </div>
//                   <div>
//                     <strong>Word Count:</strong> {{ result.data?.wordCount }}
//                   </div>
//                 </div>
//                 <div class="col-12 col-md-6">
//                   <div>
//                     <strong>Links:</strong> {{ result.data?.linkCount }}
//                   </div>
//                   <div>
//                     <strong>Images:</strong> {{ result.data?.imageCount }}
//                   </div>
//                   <div>
//                     <strong>Tables:</strong> {{ result.data?.tableCount }}
//                   </div>
//                   <div>
//                     <strong>Forms:</strong> {{ result.data?.formCount }}
//                   </div>
//                 </div>
//               </div>
//               <details class="mt-2">
//                 <summary>Framework Signals</summary>
//                 <pre class="mt-2">{{
//                   result.data?.frameworkSignals | json
//                 }}</pre>
//               </details>
//             </div>
//           </div>

//           <!-- Strategy Selector -->
//           <div *ngIf="selected === 'strategy' && result" class="card mb-3">
//             <div class="card-header">Scraping Strategy</div>
//             <div class="card-body">
//               <div><strong>Status:</strong> {{ result.data?.status }}</div>
//               <div>
//                 <strong>Recommended Strategy:</strong>
//                 {{ result.data?.strategy }}
//               </div>
//               <details class="mt-2">
//                 <summary>Signals</summary>
//                 <pre class="mt-2">{{ result.data?.signals | json }}</pre>
//               </details>
//             </div>
//           </div>

//           <!-- Data Extractor -->
//           <div *ngIf="selected === 'extract' && result" class="card mb-3">
//             <div class="card-header">Extracted Data</div>
//             <div class="card-body">
//               <div class="mb-2">
//                 <strong>Title:</strong> {{ result.data?.title }}
//               </div>
//               <div class="mb-2">
//                 <strong>H1:</strong> {{ result.data?.pageHeading }}
//               </div>
//               <div class="mb-2">
//                 <strong>Link Stats:</strong>
//                 {{ result.data?.stats?.totalLinks }} total,
//                 {{ result.data?.stats?.percentWithText }}% with text,
//                 {{ result.data?.stats?.percentWithTitleAttr }}% with title
//                 attribute
//               </div>
//               <div class="d-flex gap-2 mb-2">
//                 <button
//                   class="btn btn-sm btn-outline-primary"
//                   (click)="exportJSON(result.data?.links || [], 'links.json')"
//                   [disabled]="!result.data?.links?.length"
//                 >
//                   Export Links JSON
//                 </button>
//                 <button
//                   class="btn btn-sm btn-outline-secondary"
//                   (click)="exportCSV(result.data?.links || [], 'links.csv')"
//                   [disabled]="!result.data?.links?.length"
//                 >
//                   Export Links CSV
//                 </button>
//               </div>
//               <div class="table-responsive" *ngIf="result.data?.links?.length">
//                 <table class="table table-sm table-striped">
//                   <thead>
//                     <tr>
//                       <th>Text</th>
//                       <th>Href</th>
//                       <th>Title Attr</th>
//                       <th>Text Coverage %</th>
//                     </tr>
//                   </thead>
//                   <tbody>
//                     <tr *ngFor="let l of result.data.links">
//                       <td>{{ l.text }}</td>
//                       <td>
//                         <a [href]="l.href" target="_blank" rel="noopener">{{
//                           l.href
//                         }}</a>
//                       </td>
//                       <td>{{ l.titleAttr }}</td>
//                       <td>{{ l.textCoveragePct }}</td>
//                     </tr>
//                   </tbody>
//                 </table>
//               </div>
//             </div>
//           </div>

//           <!-- Data Exporter (generic) -->
//           <div *ngIf="selected === 'export'" class="card mb-3">
//             <div class="card-header">Data Exporter</div>
//             <div class="card-body">
//               <div class="mb-2">
//                 Exports the most recent result shown in any flow.
//               </div>
//               <div class="d-flex gap-2 flex-wrap">
//                 <button
//                   class="btn btn-success"
//                   (click)="exportJSON(result, 'result.json')"
//                   [disabled]="!result"
//                 >
//                   Export Result JSON
//                 </button>
//                 <button
//                   class="btn btn-secondary"
//                   (click)="tryExportCSV(result)"
//                 >
//                   Export Result CSV
//                 </button>
//               </div>
//               <div class="form-text mt-2" *ngIf="!result">
//                 No result yet. Run a flow first.
//               </div>
//             </div>
//           </div>

//           <!-- Fallback raw output -->
//           <div class="card" *ngIf="result && showRaw">
//             <div class="card-header">Raw Output</div>
//             <div class="card-body">
//               <pre class="mb-0">{{ result | json }}</pre>
//             </div>
//           </div>
//         </div>
//       </div>
//     </div>
//   `,
// })
// export class AppComponent {
//   url = '';
//   selected: FlowKey = 'url';
//   loading = false;
//   result: any = null;
//   showRaw = false;

//   constructor(private service: ScrapeService) {}

//   select(key: FlowKey) {
//     this.selected = key;
//   }

//   flowLabel(key: FlowKey) {
//     switch (key) {
//       case 'url':
//         return 'URL Analyzer';
//       case 'content':
//         return 'Content Detector';
//       case 'strategy':
//         return 'Scraping Strategy Selector';
//       case 'extract':
//         return 'Data Extractor';
//       case 'export':
//         return 'Data Exporter';
//     }
//   }

//   runSelected() {
//     if (!this.url) return;
//     this.loading = true;
//     this.result = null;
//     const done = (r: any) => {
//       this.result = r;
//       this.loading = false;
//     };
//     const fail = (e: any) => {
//       this.result = e?.error || e;
//       this.loading = false;
//     };

//     if (this.selected === 'url') {
//       this.service.analyzeUrl(this.url).subscribe({ next: done, error: fail });
//     } else if (this.selected === 'content') {
//       this.service
//         .detectContent(this.url)
//         .subscribe({ next: done, error: fail });
//     } else if (this.selected === 'strategy') {
//       this.service
//         .selectStrategy(this.url)
//         .subscribe({ next: done, error: fail });
//     } else if (this.selected === 'extract') {
//       this.service.extractData(this.url).subscribe({ next: done, error: fail });
//     } else if (this.selected === 'export') {
//       this.loading = false; // nothing to run
//     }
//   }

//   exportJSON(data: any, filename: string) {
//     const blob = new Blob([JSON.stringify(data ?? {}, null, 2)], {
//       type: 'application/json',
//     });
//     this.downloadBlob(blob, filename);
//   }

//   exportCSV(rows: any[], filename: string) {
//     const csv = this.toCSV(rows || []);
//     const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
//     this.downloadBlob(blob, filename);
//   }

//   tryExportCSV(anyResult: any) {
//     if (!anyResult) return;
//     const rows = anyResult?.data?.links || anyResult?.links || [];
//     if (!Array.isArray(rows) || rows.length === 0) return;
//     this.exportCSV(rows, 'result.csv');
//   }

//   private toCSV(arr: any[]): string {
//     if (!Array.isArray(arr) || arr.length === 0) return '';
//     const headers = Array.from(
//       arr.reduce((set, obj) => {
//         Object.keys(obj || {}).forEach((k) => set.add(k));
//         return set;
//       }, new Set<string>()),
//     );
//     const esc = (v: any) => {
//       if (v === null || v === undefined) return '';
//       const s = String(v).replace(/"/g, '""');
//       return /[",\n]/.test(s) ? `"${s}"` : s;
//     };
//     const lines = [headers.join(',')];
//     for (const row of arr) {
//       lines.push(headers.map((h: any) => esc((row as any)[h])).join(','));
//     }
//     return lines.join('\n');
//   }

//   private downloadBlob(blob: Blob, filename: string) {
//     const url = URL.createObjectURL(blob);
//     const a = document.createElement('a');
//     a.href = url;
//     a.download = filename;
//     document.body.appendChild(a);
//     a.click();
//     a.remove();
//     URL.revokeObjectURL(url);
//   }
// }
import { Component } from '@angular/core';

@Component({
  selector: 'app-root',
  template: `
    <div class="container-fluid py-3" style="height: 100%;">
      <div class="row">
        <div class="col-12 col-md-3 col-lg-2 mb-3">
          <div class="list-group">
            <a
              routerLink="/url"
              routerLinkActive="active"
              class="list-group-item list-group-item-action"
              >URL Analyzer</a
            >
            <a
              routerLink="/content"
              routerLinkActive="active"
              class="list-group-item list-group-item-action"
              >Content Detector</a
            >
            <a
              routerLink="/strategy"
              routerLinkActive="active"
              class="list-group-item list-group-item-action"
              >Scraping Strategy</a
            >
            <a
              routerLink="/extract"
              routerLinkActive="active"
              class="list-group-item list-group-item-action"
              >Data Extractor</a
            >
            <a
              routerLink="/parent-tree"
              routerLinkActive="active"
              class="list-group-item list-group-item-action"
              >Parent Tree Algorithm</a
            >
            <a
              routerLink="/search"
              routerLinkActive="active"
              class="list-group-item list-group-item-action"
              >Search</a
            >
            <a
              routerLink="/export"
              routerLinkActive="active"
              class="list-group-item list-group-item-action"
              >Data Exporter</a
            >
          </div>
        </div>
        <div class="col-12 col-md-9 col-lg-10">
          <router-outlet></router-outlet>
        </div>
      </div>
    </div>
  `,
})
export class AppComponent {}
