import { HttpClient } from '@angular/common/http';
import { Component, OnDestroy } from '@angular/core';

interface KeywordMatch {
  value: string;
  snippet: string;
  pageUrl: string;
  confidence?: number;
  numericValue?: number | null;
  section?: string | null;
}

interface KeywordSummary {
  keyword: string;
  matchMode?: 'text' | 'number';
  keywordMatches: KeywordMatch[];
  keywordHit: KeywordMatch | null;
}

interface KeywordTabState {
  keyword: string;
  matches: KeywordMatch[];
  currentPage: number;
}

interface CompanyData {
  website: string;
  companyName: string;
  metaDescription: string;
  contactPageUrl: string;
  extractedAddress: string | null;
  extractedAddresses: string[];
  contactPageContent: string;
  methodUsed?: string;
  keyword?: string;
  keywords?: string[];
  keywordMatches: KeywordMatch[];
  keywordHit: KeywordMatch | null;
  keywordSummaries?: KeywordSummary[];
  jobId?: string;
  partial?: boolean;
  crawlStatus?: 'completed' | 'aborted' | 'stopped' | 'running';
  message?: string;
  source?: 'live' | 'cache';
  cachedAt?: number;
  cacheId?: string;
  cacheDomain?: string;
  relevanceStats?: {
    kept: number;
    skipped: number;
  };
  resultsLimited?: boolean;
  currentUrl?: string;
  currentDepth?: number;
  visitedCount?: number;
  queueSize?: number;
  lastUpdated?: number;
}

interface SearchResponse {
  success: boolean;
  data?: CompanyData;
  error?: string;
  cacheHit?: boolean;
  jobId?: string;
  status?: 'running' | 'completed' | 'failed' | 'aborted' | 'aborting';
  completed?: boolean;
  failed?: boolean;
  updatedAt?: number;
}

interface GoogleSearchMatch {
  title: string;
  link: string;
  snippet: string;
}

interface GoogleKeywordResult {
  keyword: string;
  query: string;
  matches: GoogleSearchMatch[];
  error?: string;
}

interface GoogleSearchResponse {
  success: boolean;
  data?: {
    domain: string;
    results: GoogleKeywordResult[];
  };
  error?: string;
}

@Component({
  selector: 'app-search',
  template: `
    <div class="card">
      <div class="card-header">Search</div>
      <div class="card-body">
        <form (ngSubmit)="runSearch()" class="row g-3" novalidate>
          <div class="col-12 col-md-4">
            <label class="form-label" for="search-keyword">Keywords</label>
            <textarea
              id="search-keyword"
              class="form-control"
              name="keyword"
              [(ngModel)]="keywordsInput"
              placeholder="employee, revenue"
              rows="3"
              required
            ></textarea>
            <small class="text-muted">
              Separate keywords with commas or new lines.
            </small>
            <small class="text-muted d-block">
              We'll check cached company pages first, then launch a fresh crawl
              if needed.
            </small>
          </div>
          <div class="col-12 mt-3" *ngIf="keywordTabs.length">
            <div
              class="d-flex flex-wrap gap-2 mb-3 justify-content-between align-items-center"
            >
              <div class="d-flex flex-wrap gap-2">
                <button
                  type="button"
                  class="btn"
                  [ngClass]="
                    activeTab?.keyword === tab.keyword
                      ? 'btn-primary text-white'
                      : 'btn-outline-secondary'
                  "
                  *ngFor="let tab of keywordTabs"
                  (click)="setActiveKeyword(tab.keyword)"
                >
                  {{ tab.keyword }} ({{ tab.matches.length }})
                </button>
              </div>
              <button
                type="button"
                class="btn btn-outline-primary"
                (click)="exportKeywordMatches()"
                [disabled]="!hasKeywordResults"
                title="Download all extracted matches as CSV"
              >
                Export Results
              </button>
            </div>
            <ng-container *ngIf="activeTab as tab">
              <ng-container *ngIf="tab.matches.length; else noKeywordMatches">
                <div class="text-muted mb-2">
                  Showing {{ activeTabRangeStart }} - {{ activeTabRangeEnd }} of
                  {{ tab.matches.length }} matches
                </div>
                <ul class="list-group mb-3">
                  <li
                    class="list-group-item"
                    *ngFor="let match of activeTabMatches"
                  >
                    <div class="fw-semibold">{{ match.value }}</div>
                    <div class="text-muted small" *ngIf="match.section">
                      Section: {{ match.section }}
                    </div>
                    <div class="text-muted small" *ngIf="match.pageUrl">
                      Source:
                      <a
                        [href]="match.pageUrl"
                        target="_blank"
                        rel="noreferrer"
                        >{{ match.pageUrl }}</a
                      >
                    </div>
                    <div class="text-muted" *ngIf="match.snippet">
                      "{{ match.snippet }}"
                    </div>
                  </li>
                </ul>
                <div
                  class="d-flex justify-content-between align-items-center gap-2"
                  *ngIf="tab.matches.length > KEYWORD_PAGE_SIZE"
                >
                  <button
                    type="button"
                    class="btn btn-outline-secondary"
                    (click)="changeActivePage(-1)"
                    [disabled]="tab.currentPage === 1"
                  >
                    Previous
                  </button>
                  <div class="small text-muted">
                    Page {{ tab.currentPage }} of {{ activeTabTotalPages }}
                  </div>
                  <button
                    type="button"
                    class="btn btn-outline-secondary"
                    (click)="changeActivePage(1)"
                    [disabled]="tab.currentPage === activeTabTotalPages"
                  >
                    Next
                  </button>
                </div>
              </ng-container>
            </ng-container>
            <ng-template #noKeywordMatches>
              <div class="text-muted">No matches found for this keyword.</div>
            </ng-template>
          </div>
          <div class="col-12 col-md-4">
            <label class="form-label" for="search-url">URL</label>
            <input
              id="search-url"
              class="form-control"
              name="url"
              [(ngModel)]="url"
              placeholder="https://example.com"
              required
              type="url"
            />
          </div>
          <div class="col-12 col-md-4">
            <label class="form-label" for="search-depth">
              Max Depth (optional)
            </label>
            <input
              id="search-depth"
              class="form-control"
              name="maxDepth"
              [(ngModel)]="maxDepth"
              type="number"
              min="0"
              placeholder="Leave blank for full crawl"
            />
            <small class="text-muted">Limits how deep the crawler goes.</small>
          </div>

          <div class="col-12 d-flex gap-2">
            <button
              class="btn btn-primary"
              type="submit"
              [disabled]="!url || !keywordsInput.trim() || isSearching"
            >
              {{ isSearching ? 'Searching...' : 'Search' }}
            </button>
            <button
              class="btn btn-outline-info"
              type="button"
              (click)="runGoogleSearch()"
              [disabled]="!url || !keywordsInput.trim() || isGoogleSearching"
            >
              {{ isGoogleSearching ? 'Google Searching...' : 'Google Search' }}
            </button>
            <button
              class="btn btn-outline-danger"
              type="button"
              (click)="stopSearch()"
              [disabled]="!isSearching || stopRequested || !currentJobId"
            >
              {{ stopRequested ? 'Stopping...' : 'Stop' }}
            </button>
            <button
              class="btn btn-outline-secondary"
              type="button"
              (click)="clear()"
              [disabled]="isSearching || (!url && !keywordsInput)"
            >
              Clear
            </button>
          </div>
        </form>

        <div *ngIf="isSearching" class="alert alert-info mt-3">
          {{
            currentJobId
              ? 'Crawling site and collecting links...'
              : 'Checking cached crawl data...'
          }}
        </div>

        <div *ngIf="error" class="alert alert-danger mt-3">
          {{ error }}
        </div>

        <div *ngIf="isGoogleSearching" class="alert alert-info mt-3">
          Running Google search for the provided keywords...
        </div>

        <div *ngIf="googleError" class="alert alert-danger mt-3">
          {{ googleError }}
        </div>

        <div *ngIf="!isSearching && result" class="mt-3">
          <div *ngIf="result.partial" class="alert alert-warning">
            {{ result.message || 'Crawl stopped before completion.' }}
          </div>
          <div
            *ngIf="!result.partial && result.message"
            class="alert alert-info"
          >
            {{ result.message }}
          </div>
          <div *ngIf="result.source === 'cache'" class="alert alert-info">
            Showing cached crawl from
            {{ result.cachedAt | date: 'short' }}.
          </div>
          <h5 class="mb-2">Company Overview</h5>
          <div class="text-muted small mb-2" *ngIf="result.relevanceStats">
            Filtered {{ result.relevanceStats.kept }} relevant links and skipped
            {{ result.relevanceStats.skipped || 0 }} low-signal matches.
          </div>
          <div class="mb-2"><strong>Website:</strong> {{ result.website }}</div>
          <div class="mb-2" *ngIf="result.jobId">
            <strong>Job ID:</strong> {{ result.jobId }}
          </div>
          <div class="mb-2">
            <strong>Company Name:</strong> {{ result.companyName || 'N/A' }}
          </div>
          <!-- <div class="mb-2">
            <strong>Meta Description:</strong>
            {{ result.metaDescription || 'N/A' }}
          </div>
          <div class="mb-2" *ngIf="result.contactPageUrl">
            <strong>Contact Page:</strong>
            <a [href]="result.contactPageUrl" target="_blank" rel="noreferrer">
              {{ result.contactPageUrl }}
            </a>
          </div>
          <ng-container
            *ngIf="result.keywordSummaries?.length; else singleKeywordBlock"
          >
            <h5 class="mb-2">Keyword Matches</h5>
            <ng-template #noKeywordMatch>
              <div class="text-muted small">No matches found.</div>
            </ng-template>
            <div
              *ngFor="let summary of result.keywordSummaries"
              class="mb-3 p-3 border rounded"
            >
              <div class="fw-semibold mb-1">
                {{ summary.keyword }}
                <span
                  class="text-muted small"
                  *ngIf="summary.matchMode === 'number'"
                >
                  (numeric)
                </span>
              </div>
              <ng-container
                *ngIf="summary.keywordHit as keywordHit; else noKeywordMatch"
              >
                <div>{{ keywordHit.value }}</div>
                <div class="text-muted small" *ngIf="keywordHit.section">
                  Section: {{ keywordHit.section }}
                </div>
                <div class="text-muted small" *ngIf="keywordHit.pageUrl">
                  Source:
                  <a
                    [href]="keywordHit.pageUrl"
                    target="_blank"
                    rel="noreferrer"
                  >
                    {{ keywordHit.pageUrl }}
                  </a>
                </div>
                <div
                  class="text-muted keyword-snippet"
                  *ngIf="keywordHit.snippet"
                >
                  "{{ keywordHit.snippet }}"
                </div>
              </ng-container>
              <div class="mt-2" *ngIf="summary.keywordMatches.length > 1">
                <div class="text-muted small">Other mentions:</div>
                <ul class="mb-0 ps-3 address-list">
                  <li
                    *ngFor="let match of summary.keywordMatches.slice(1)"
                    class="address-item"
                  >
                    {{ match.value }}
                    <span class="text-muted small" *ngIf="match.section">
                      ({{ match.section }})
                    </span>
                    <span class="text-muted small" *ngIf="match.pageUrl">
                      -
                      <a
                        [href]="match.pageUrl"
                        target="_blank"
                        rel="noreferrer"
                      >
                        open page
                      </a>
                    </span>
                  </li>
                </ul>
              </div>
            </div>
          </ng-container>
          <ng-template #singleKeywordBlock>
            <div class="mb-2" *ngIf="result.keywordHit as keywordHit">
              <strong> Match Found: </strong>
              <div>{{ keywordHit.value }}</div>
              <div class="text-muted small" *ngIf="keywordHit.section">
                Section: {{ keywordHit.section }}
              </div>
              <div class="text-muted small" *ngIf="keywordHit.pageUrl">
                Source:
                <a [href]="keywordHit.pageUrl" target="_blank" rel="noreferrer">
                  {{ keywordHit.pageUrl }}
                </a>
              </div>
              <div
                class="text-muted keyword-snippet"
                *ngIf="keywordHit.snippet"
              >
                "{{ keywordHit.snippet }}"
              </div>
            </div>
            <div class="mb-2" *ngIf="result.keywordMatches.length > 1">
              <strong>Other Matches:</strong>
              <ul class="mb-0 ps-3 address-list">
                <li
                  *ngFor="let match of result.keywordMatches.slice(1)"
                  class="address-item"
                >
                  {{ match.value }}
                  <span class="text-muted small" *ngIf="match.section">
                    ({{ match.section }})
                  </span>
                  <span class="text-muted small" *ngIf="match.pageUrl">
                    -
                    <a [href]="match.pageUrl" target="_blank" rel="noreferrer">
                      open page
                    </a>
                  </span>
                </li>
              </ul>
            </div>
          </ng-template>
          <div class="mb-2">
            <strong>
              Extracted Address{{
                result.extractedAddresses.length > 1 ? 'es' : ''
              }}:
            </strong>
            <ng-container
              *ngIf="result.extractedAddresses?.length; else addressFallback"
            >
              <ul class="mb-0 ps-3 address-list">
                <li
                  *ngFor="let addr of result.extractedAddresses"
                  class="address-item"
                >
                  <div class="address-block" [innerText]="addr"></div>
                </li>
              </ul>
            </ng-container>
            <ng-template #addressFallback>
              {{ result.extractedAddress || 'N/A' }}
            </ng-template>
          </div>
          <div class="mb-2" *ngIf="result.contactPageContent">
            <strong>Contact Page Content:</strong>
            <pre class="content-preview">{{ result.contactPageContent }}</pre>
          </div> -->
        </div>

        <div *ngIf="googleResults.length && !isGoogleSearching" class="mt-3">
          <div class="card">
            <div class="card-header">
              Google Search Results
              <span *ngIf="googleDomain">for {{ googleDomain }}</span>
            </div>
            <div class="card-body">
              <p class="text-muted small mb-3">
                Site-scoped Google results for each keyword (top
                {{ googleResultsLimit }} matches).
              </p>
              <div
                *ngFor="let summary of googleResults; let last = last"
                class="pb-3"
                [class.mb-3]="!last"
                [class.border-bottom]="!last"
              >
                <div class="d-flex justify-content-between align-items-center">
                  <h6 class="mb-1">{{ summary.keyword }}</h6>
                  <a
                    class="small"
                    [href]="toGoogleQueryLink(summary.query)"
                    target="_blank"
                    rel="noreferrer"
                  >
                    view on Google
                  </a>
                </div>
                <div class="text-muted small mb-2">
                  Query: {{ summary.query }}
                </div>
                <ul
                  *ngIf="summary.matches.length; else noGoogleMatches"
                  class="mb-0 ps-3 google-result-list"
                >
                  <li *ngFor="let match of summary.matches">
                    <a [href]="match.link" target="_blank" rel="noreferrer">
                      {{ match.title || match.link }}
                    </a>
                    <div class="text-muted small">
                      {{ match.snippet || 'No snippet available.' }}
                    </div>
                  </li>
                </ul>
                <ng-template #noGoogleMatches>
                  <div class="text-muted small">
                    No Google results found
                    <span *ngIf="summary.error">({{ summary.error }})</span>.
                  </div>
                </ng-template>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `,
  styles: [
    `
      .content-preview {
        max-height: 200px;
        overflow: auto;
        background: #f8f9fa;
        padding: 12px;
        border-radius: 4px;
        border: 1px solid #e5e7eb;
      }
      .address-block {
        white-space: pre-line;
      }
      .keyword-snippet {
        display: block;
        margin-top: 4px;
      }
      .google-result-list li {
        margin-bottom: 0.75rem;
      }
      .google-result-list li:last-child {
        margin-bottom: 0;
      }
    `,
  ],
})
export class SearchComponent implements OnDestroy {
  readonly KEYWORD_PAGE_SIZE = 15;
  readonly API_BASE = 'http://localhost:3000';
  private readonly STATUS_POLL_INTERVAL = 2000;
  keywordsInput = '';
  url = '';
  maxDepth = '';
  isSearching = false;
  error: string | null = null;
  result: CompanyData | null = null;
  keywordTabs: KeywordTabState[] = [];
  activeKeyword: string | null = null;
  googleResults: GoogleKeywordResult[] = [];
  googleDomain = '';
  isGoogleSearching = false;
  googleError: string | null = null;
  googleResultsLimit = 5;
  currentJobId: string | null = null;
  stopRequested = false;
  private statusPollHandle: ReturnType<typeof setTimeout> | null = null;

  constructor(private http: HttpClient) {}

  ngOnDestroy() {
    this.cancelStatusPolling();
  }

  async runSearch() {
    const trimmedUrl = this.url?.trim();
    if (!trimmedUrl || !this.keywordsInput.trim()) {
      return;
    }
    const keywords = this.parseKeywords(this.keywordsInput);
    if (!keywords.length) {
      this.error = 'Enter at least one keyword.';
      return;
    }
    this.url = trimmedUrl;
    this.error = null;
    this.result = null;
    this.keywordTabs = [];
    this.activeKeyword = null;
    this.isSearching = true;
    this.stopRequested = false;
    this.currentJobId = null;
    this.cancelStatusPolling();
    const baseParams = this.buildSearchParams(keywords);
    const jobId = this.generateJobId();
    const liveParams = { ...baseParams, jobId };
    this.tryCachedSearch(baseParams, liveParams, jobId);
  }

  stopSearch() {
    if (!this.isSearching || !this.currentJobId || this.stopRequested) {
      return;
    }
    this.stopRequested = true;
    this.http
      .post<{
        success: boolean;
        error?: string;
      }>(`${this.API_BASE}/search/stop`, { jobId: this.currentJobId })
      .subscribe({
        error: (err) => {
          this.stopRequested = false;
          const message =
            err?.error?.error ||
            err?.message ||
            'Unable to stop the current crawl.';
          if (err?.status !== 404) {
            this.error = message;
          }
        },
      });
  }

  private parseKeywords(raw: string): string[] {
    return raw
      .split(/[\n,]+/)
      .map((value) => value.trim())
      .filter((value) => !!value);
  }

  private generateJobId(): string {
    const hasCrypto =
      typeof window !== 'undefined' &&
      typeof window.crypto !== 'undefined' &&
      typeof window.crypto.randomUUID === 'function';
    if (hasCrypto) {
      return window.crypto.randomUUID();
    }
    return `${Date.now().toString(36)}${Math.random()
      .toString(36)
      .slice(2, 10)}`;
  }

  private buildSearchParams(keywords: string[]): Record<string, string> {
    const params: Record<string, string> = { url: this.url };
    params['keywords'] = keywords.join(',');
    params['keyword'] = keywords[0];
    if (
      this.maxDepth !== '' &&
      this.maxDepth !== null &&
      this.maxDepth !== undefined
    ) {
      const depthValue = Number(this.maxDepth);
      if (!Number.isNaN(depthValue) && depthValue >= 0) {
        params['maxDepth'] = String(Math.floor(depthValue));
      }
    }
    return params;
  }

  private tryCachedSearch(
    cacheParams: Record<string, string>,
    liveParams: Record<string, string>,
    jobId: string,
  ) {
    this.http
      .get<SearchResponse>(`${this.API_BASE}/search/cache`, {
        params: cacheParams,
      })
      .subscribe({
        next: (resp) => {
          if (resp.success && resp.data) {
            this.updateResultFromSnapshot({
              ...resp.data,
              source: 'cache',
            });
            this.markJobComplete();
            return;
          }
          this.startLiveSearch(jobId, liveParams);
        },
        error: () => {
          this.startLiveSearch(jobId, liveParams);
        },
      });
  }

  private startLiveSearch(jobId: string, params: Record<string, string>): void {
    params['jobId'] = jobId;
    this.currentJobId = jobId;
    this.stopRequested = false;
    this.result = null;
    this.keywordTabs = [];
    this.activeKeyword = null;
    this.http
      .get<SearchResponse>(`${this.API_BASE}/search/start`, {
        params,
      })
      .subscribe({
        next: (resp) => {
          if (!resp.success || !(resp.jobId || jobId)) {
            this.handleSearchError(
              resp.error || 'Unable to start the crawl for the provided URL.',
            );
            return;
          }
          const activeJobId = resp.jobId || jobId;
          this.currentJobId = activeJobId;
          this.stopRequested = false;
          this.scheduleStatusPoll(activeJobId, 0);
        },
        error: (err) => {
          const message =
            err?.error?.error ||
            err?.message ||
            'Unable to start the crawl for the provided URL.';
          this.handleSearchError(message);
        },
      });
  }

  private pollJobStatus(jobId: string) {
    if (!this.currentJobId || this.currentJobId !== jobId) {
      return;
    }
    this.http
      .get<SearchResponse>(`${this.API_BASE}/search/status`, {
        params: { jobId },
      })
      .subscribe({
        next: (resp) => {
          if (!this.currentJobId || this.currentJobId !== jobId) {
            return;
          }
          if (!resp.success) {
            this.scheduleStatusPoll(jobId);
            return;
          }
          if (resp.data) {
            this.updateResultFromSnapshot(resp.data);
          }
          const status =
            resp.status ||
            (resp.completed ? 'completed' : resp.failed ? 'failed' : 'running');
          const isFinal =
            resp.completed ||
            resp.failed ||
            status === 'completed' ||
            status === 'failed' ||
            status === 'aborted';
          if (isFinal) {
            const errorMessage =
              resp.error && status !== 'completed' ? resp.error : undefined;
            this.markJobComplete(errorMessage);
            return;
          }
          this.scheduleStatusPoll(jobId);
        },
        error: () => {
          if (!this.currentJobId || this.currentJobId !== jobId) {
            return;
          }
          this.scheduleStatusPoll(jobId);
        },
      });
  }

  private scheduleStatusPoll(jobId: string, delay = this.STATUS_POLL_INTERVAL) {
    this.cancelStatusPolling();
    this.statusPollHandle = setTimeout(() => this.pollJobStatus(jobId), delay);
  }

  private cancelStatusPolling() {
    if (this.statusPollHandle) {
      clearTimeout(this.statusPollHandle);
      this.statusPollHandle = null;
    }
  }

  private updateResultFromSnapshot(data: CompanyData) {
    const preserveTabs = !!this.result && this.keywordTabs.length > 0;
    const previousPages = preserveTabs
      ? new Map(this.keywordTabs.map((tab) => [tab.keyword, tab.currentPage]))
      : undefined;
    this.result = data;
    this.setupKeywordTabs(data, preserveTabs, previousPages);
  }

  private markJobComplete(errorMessage?: string) {
    this.isSearching = false;
    this.stopRequested = false;
    this.cancelStatusPolling();
    this.currentJobId = null;
    this.error = errorMessage || null;
  }

  private handleSearchError(message: string) {
    this.cancelStatusPolling();
    this.isSearching = false;
    this.stopRequested = false;
    this.currentJobId = null;
    this.result = null;
    this.keywordTabs = [];
    this.activeKeyword = null;
    this.error = message;
  }

  runGoogleSearch() {
    const trimmedUrl = this.url?.trim();
    if (!trimmedUrl || !this.keywordsInput.trim()) {
      this.googleError = 'URL and at least one keyword are required.';
      return;
    }
    const keywords = this.parseKeywords(this.keywordsInput);
    if (!keywords.length) {
      this.googleError = 'Enter at least one keyword.';
      return;
    }
    this.url = trimmedUrl;
    this.googleError = null;
    this.googleResults = [];
    this.googleDomain = '';
    this.isGoogleSearching = true;
    const params: Record<string, string> = {
      url: trimmedUrl,
      keywords: keywords.join(','),
    };
    if (keywords[0]) {
      params['keyword'] = keywords[0];
    }
    const defaultMaxResults = 5;
    this.googleResultsLimit = defaultMaxResults;
    params['maxResults'] = String(defaultMaxResults);
    this.http
      .get<GoogleSearchResponse>(`${this.API_BASE}/google-search`, {
        params,
      })
      .subscribe({
        next: (resp) => {
          this.isGoogleSearching = false;
          if (!resp.success || !resp.data) {
            this.googleError =
              resp.error || 'Unable to fetch Google search results.';
            return;
          }
          this.googleDomain = resp.data.domain;
          this.googleResults = resp.data.results || [];
          if (!this.googleResults.length) {
            this.googleError =
              'No Google results were returned for the provided keywords.';
          }
        },
        error: (err) => {
          this.isGoogleSearching = false;
          this.googleError =
            err?.message || 'Unexpected error while running Google search.';
        },
      });
  }

  clear() {
    this.keywordsInput = '';
    this.url = '';
    this.maxDepth = '';
    this.error = null;
    this.result = null;
    this.keywordTabs = [];
    this.activeKeyword = null;
    this.googleResults = [];
    this.googleDomain = '';
    this.googleError = null;
    this.isGoogleSearching = false;
    this.googleResultsLimit = 5;
    this.currentJobId = null;
    this.stopRequested = false;
    this.isSearching = false;
    this.cancelStatusPolling();
  }

  toGoogleQueryLink(query: string) {
    return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
  }

  get activeTab(): KeywordTabState | null {
    if (!this.keywordTabs.length) {
      return null;
    }
    if (!this.activeKeyword) {
      return this.keywordTabs[0];
    }
    return (
      this.keywordTabs.find((tab) => tab.keyword === this.activeKeyword) ||
      this.keywordTabs[0]
    );
  }

  get activeTabMatches(): KeywordMatch[] {
    const tab = this.activeTab;
    if (!tab) return [];
    const start = (tab.currentPage - 1) * this.KEYWORD_PAGE_SIZE;
    return tab.matches.slice(start, start + this.KEYWORD_PAGE_SIZE);
  }

  get activeTabTotalPages(): number {
    const tab = this.activeTab;
    if (!tab || !tab.matches.length) return 1;
    return Math.max(1, Math.ceil(tab.matches.length / this.KEYWORD_PAGE_SIZE));
  }

  get activeTabRangeStart(): number {
    const tab = this.activeTab;
    if (!tab || !tab.matches.length) return 0;
    return (tab.currentPage - 1) * this.KEYWORD_PAGE_SIZE + 1;
  }

  get activeTabRangeEnd(): number {
    const tab = this.activeTab;
    if (!tab || !tab.matches.length) return 0;
    return Math.min(
      tab.currentPage * this.KEYWORD_PAGE_SIZE,
      tab.matches.length,
    );
  }

  get hasKeywordResults(): boolean {
    return this.keywordTabs.some((tab) => tab.matches.length > 0);
  }

  setActiveKeyword(keyword: string) {
    this.activeKeyword = keyword;
    const tab = this.activeTab;
    if (tab && tab.currentPage < 1) {
      tab.currentPage = 1;
    }
  }

  exportKeywordMatches(): void {
    if (!this.hasKeywordResults) {
      return;
    }
    const rows: Array<Record<string, string | number | null>> = [];
    for (const tab of this.keywordTabs) {
      for (const match of tab.matches) {
        rows.push({
          Keyword: tab.keyword,
          Value: match.value || '',
          Snippet: match.snippet || '',
          'Page URL': match.pageUrl || '',
          Section: match.section || '',
          Confidence:
            typeof match.confidence === 'number'
              ? match.confidence.toFixed(2)
              : '',
          'Numeric Value':
            typeof match.numericValue === 'number'
              ? match.numericValue
              : '',
        });
      }
    }
    if (!rows.length) {
      return;
    }
    const headers = Object.keys(rows[0]);
    const escape = (value: string | number | null) => {
      if (value === null || value === undefined) {
        return '""';
      }
      const text = String(value).replace(/"/g, '""');
      return `"${text}"`;
    };
    const csvLines = [
      headers.map((h) => escape(h)).join(','),
      ...rows.map((row) => headers.map((h) => escape(row[h] ?? '')).join(',')),
    ];
    const blob = new Blob([csvLines.join('\r\n')], {
      type: 'text/csv;charset=utf-8;',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    const dateSuffix = new Date().toISOString().slice(0, 10);
    link.download = `keyword-results-${dateSuffix}.csv`;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  changeActivePage(delta: number) {
    const tab = this.activeTab;
    if (!tab) return;
    const next = tab.currentPage + delta;
    if (next < 1 || next > this.activeTabTotalPages) return;
    tab.currentPage = next;
  }

  private setupKeywordTabs(
    data: CompanyData,
    preserveSelection = false,
    previousPages?: Map<string, number>,
  ) {
    const previousActive = preserveSelection ? this.activeKeyword : null;
    const summaries =
      data.keywordSummaries && data.keywordSummaries.length
        ? data.keywordSummaries
        : [
            {
              keyword: data.keyword || data.keywords?.[0] || 'Keyword',
              keywordMatches: data.keywordMatches || [],
              keywordHit: data.keywordHit || null,
            },
          ];
    this.keywordTabs = summaries.map((summary) => {
      const keyword = summary.keyword || 'Keyword';
      const storedPage = previousPages?.get(keyword) || 0;
      const currentPage = storedPage > 0 ? storedPage : 1;
      return {
        keyword,
        matches: summary.keywordMatches || [],
        currentPage,
      };
    });
    if (!this.keywordTabs.length) {
      this.activeKeyword = null;
      return;
    }
    if (preserveSelection && previousActive) {
      const existing = this.keywordTabs.find(
        (tab) => tab.keyword === previousActive,
      );
      this.activeKeyword = existing
        ? existing.keyword
        : this.keywordTabs[0].keyword;
    } else {
      this.activeKeyword = this.keywordTabs[0]?.keyword || null;
    }
  }
}
