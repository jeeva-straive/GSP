import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';

@Injectable({ providedIn: 'root' })
export class ScrapeService {
  constructor(private http: HttpClient) {}

  scrapeProject(url: string) {
    return this.http.post<any>('http://localhost:3000/scrape', {
      projectUrl: url,
    });
  }

  analyzeUrl(url: string) {
    return this.http.post<any>('http://localhost:3000/analyze-url', { url });
  }

  detectContent(url: string) {
    return this.http.post<any>('http://localhost:3000/detect-content', { url });
  }

  detectFilters(url: string) {
    return this.http.post<any>('http://localhost:3000/detect-filters', { url });
  }

  buildFilteredUrl(url: string, params: any) {
    return this.http.post<any>('http://localhost:3000/build-filtered-url', { url, params });
  }

  selectStrategy(url: string) {
    return this.http.post<any>('http://localhost:3000/select-strategy', { url });
  }

  extractData(url: string) {
    return this.http.post<any>('http://localhost:3000/extract', { url });
  }

  extractLinksContent(
    links: string[],
    limit: number = 20,
    waitTime: number = 500,
    concurrency: number = 3,
  ) {
    return this.http.post<any>('http://localhost:3000/extract-links', { links, limit, waitTime, concurrency });
  }

  extractKeyValue(url: string) {
    return this.http.post<any>('http://localhost:3000/extract-keyvalue', { url });
  }

  scrapeWithStrategy(url: string, strategy: string) {
    return this.http.post<any>('http://localhost:3000/scrape-with-strategy', { url, strategy });
  }

  extractOne(url: string) {
    return this.http.post<any>('http://localhost:3000/extract-one', { url });
  }

  openParentTree(url: string) {
    return this.http.post<any>('http://localhost:3000/parent-tree', { url });
  }

  selectorSiblings(params: {
    url: string;
    parentUrl?: string;
    parentSelector?: string;
    itemsContainerSelector?: string;
    itemLinkSelector?: string;
    headless?: boolean;
    autoScope?: boolean;
  }) {
    return this.http.post<any>('http://localhost:3000/selector-siblings', params);
  }
}
