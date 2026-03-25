import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export interface JobDefinition {
  startUrls: string[];
  list?: {
    itemSelector?: string;
    linkSelector?: string | null;
    fields?: Record<string, string>;
  };
  detail?: {
    fields?: Record<string, string>;
  };
  pagination?: {
    nextSelector?: string | null;
    maxPages?: number;
  };
  behavior?: {
    headless?: boolean;
    timeout?: number;
    waitUntil?: string;
    extraWaitMs?: number;
  };
}

@Injectable({ providedIn: 'root' })
export class JobsService {
  private base = 'http://localhost:3000';

  constructor(private http: HttpClient) {}

  run(job: JobDefinition): Observable<{ success: boolean; runId: string }> {
    return this.http.post<{ success: boolean; runId: string }>(`${this.base}/jobs/run`, job);
  }

  status(id: string): Observable<{ success: boolean; status: string; rows: number; error?: string | null }>{
    return this.http.get<{ success: boolean; status: string; rows: number; error?: string | null }>(`${this.base}/jobs/${id}/status`);
  }

  result(id: string): Observable<{ success: boolean; rows: any[] }>{
    return this.http.get<{ success: boolean; rows: any[] }>(`${this.base}/jobs/${id}/result`);
  }
}

