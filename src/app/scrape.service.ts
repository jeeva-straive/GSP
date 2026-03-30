import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable, of } from 'rxjs';
import { json } from 'express';

@Injectable({ providedIn: 'root' })
export class ScrapeService {
  private apiUrl =
    'https://llmfoundry.straive.com/gemini/v1beta/models/gemini-2.5-flash-lite:generateContent';
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
    return this.http.post<any>('http://localhost:3000/build-filtered-url', {
      url,
      params,
    });
  }

  selectStrategy(url: string) {
    return this.http.post<any>('http://localhost:3000/select-strategy', {
      url,
    });
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
    return this.http.post<any>('http://localhost:3000/extract-links', {
      links,
      limit,
      waitTime,
      concurrency,
    });
  }

  extractKeyValue(url: string) {
    return this.http.post<any>('http://localhost:3000/extract-keyvalue', {
      url,
    });
  }

  scrapeWithStrategy(url: string, strategy: string) {
    return this.http.post<any>('http://localhost:3000/scrape-with-strategy', {
      url,
      strategy,
    });
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
    return this.http.post<any>(
      'http://localhost:3000/selector-siblings',
      params,
    );
  }

  LLMExtract1(rawContent: any): Observable<any> {
    let a = {
      keyword: 'CEO',
      matchMode: 'text',
      keywordMatches: [
        {
          value:
            'Company founder Robert Bosch Videos about Bosch History History Blog Supply chain Main Navigation Company Overview Supply chain Overview Purchasing Logistics Information for business partners Latest CEO blog Blog postCEO blogAI that gets things moving History stories Sustainability Main Navigation Sustainability Overview Responsible corporate governance Product responsibility Sustainable supply chai',
          snippet:
            'Company founder Robert Bosch Videos about Bosch History History Blog Supply chain Main Navigation Company Overview Supply chain Overview Purchasing Logistics Information for business partners Latest CEO blog Blog postCEO blogAI that gets things moving History stories Sustainability Main Navigation Sustainability Overview Responsible corporate governance Product responsibility Sustainable supply chai',
          confidence: 100,
          numericValue: null,
          pageUrl: 'https://www.bosch.com/company/leadership',
        },
        {
          value:
            'Board of management as of October 1st, 2024 Dr. Stefan Hartung Chairman of the board of management, Robert Bosch GmbH Dr. Stefan Hartung Dr. Stefan Hartung has been chairman of the board of management of Robert Bosch GmbH and a shareholder of Robert Bosch Industrietreuhand KG since J',
          snippet:
            'Board of management as of October 1st, 2024 Dr. Stefan Hartung Chairman of the board of management, Robert Bosch GmbH Dr. Stefan Hartung Dr. Stefan Hartung has been chairman of the board of management of Robert Bosch GmbH and a shareholder of Robert Bosch Industrietreuhand KG since J',
          confidence: 100,
          numericValue: null,
          pageUrl: 'https://www.bosch.com/company/leadership',
        },
        {
          value:
            'Dr. Stefan Hartung Dr. Stefan Hartung has been chairman of the board of management of Robert Bosch GmbH and a shareholder of Robert Bosch Industrietreuhand KG since January 1, 2022. His responsibilities include corporate strategy, corporate communications and governme',
          snippet:
            'Dr. Stefan Hartung Dr. Stefan Hartung has been chairman of the board of management of Robert Bosch GmbH and a shareholder of Robert Bosch Industrietreuhand KG since January 1, 2022. His responsibilities include corporate strategy, corporate communications and governme',
          confidence: 100,
          numericValue: null,
          pageUrl: 'https://www.bosch.com/company/leadership',
        },
        {
          value: 'To the CEO blog',
          snippet: 'To the CEO blog',
          confidence: 100,
          numericValue: null,
          pageUrl: 'https://www.bosch.com/company/leadership',
        },
        {
          value:
            'Dr. Christian Fischer Deputy chairman of the board of management, Robert Bosch GmbH',
          snippet:
            'Dr. Christian Fischer Deputy chairman of the board of management, Robert Bosch GmbH',
          confidence: 100,
          numericValue: null,
          pageUrl: 'https://www.bosch.com/company/leadership',
        },
        {
          value:
            'Dr. Christian Fischer Dr. Christian Fischer has been deputy chairman of the board of management of Robert Bosch GmbH and a shareholder of Robert Bosch Industrietreuhand KG since January 1, 2022. He is responsible for Growth and Portfolio Management of the Bosch Group and the Consu',
          snippet:
            'Dr. Christian Fischer Dr. Christian Fischer has been deputy chairman of the board of management of Robert Bosch GmbH and a shareholder of Robert Bosch Industrietreuhand KG since January 1, 2022. He is responsible for Growth and Portfolio Management of the Bosch Group and the Consu',
          confidence: 100,
          numericValue: null,
          pageUrl: 'https://www.bosch.com/company/leadership',
        },
        {
          value:
            'Prof. Dr. Stefan Asenkerschbaumer Chairman, Stuttgart Managing partner of Robert Bosch Industrietreuhand KG, formerly deputy chairman of the board of management of Robert Bosch GmbH CV and press photos Frank Sell Deputy chairman, Pleidelsheim Deputy chairman of the works council of the Feuerbach plant, and chairman of the central works council',
          snippet:
            'Prof. Dr. Stefan Asenkerschbaumer Chairman, Stuttgart Managing partner of Robert Bosch Industrietreuhand KG, formerly deputy chairman of the board of management of Robert Bosch GmbH CV and press photos Frank Sell Deputy chairman, Pleidelsheim Deputy chairman of the works council of the Feuerbach plant, and chairman of the central works council',
          confidence: 100,
          numericValue: null,
          pageUrl: 'https://www.bosch.com/company/leadership',
        },
      ],
      keywordHit: {
        value:
          'Company founder Robert Bosch Videos about Bosch History History Blog Supply chain Main Navigation Company Overview Supply chain Overview Purchasing Logistics Information for business partners Latest CEO blog Blog postCEO blogAI that gets things moving History stories Sustainability Main Navigation Sustainability Overview Responsible corporate governance Product responsibility Sustainable supply chai',
        snippet:
          'Company founder Robert Bosch Videos about Bosch History History Blog Supply chain Main Navigation Company Overview Supply chain Overview Purchasing Logistics Information for business partners Latest CEO blog Blog postCEO blogAI that gets things moving History stories Sustainability Main Navigation Sustainability Overview Responsible corporate governance Product responsibility Sustainable supply chai',
        confidence: 100,
        numericValue: null,
        pageUrl: 'https://www.bosch.com/company/leadership',
      },
    };

    const prompt = `Analyze the following text and extract JSON with:
1. employees: latest total employees (numeric, include qualifier if present).
2. revenue: most recent annual revenue (numeric + currency + fiscal year).
3. ceo: current CEO full name (mention interim if applicable).`;

    const body = JSON.stringify({
      system_instruction: {
        parts: [
          {
            text: 'You are a helpful assistant',
          },
        ],
      },
      contents: [
        {
          role: 'user',
          parts: [
            {
              inline_data: {
                mime_type: 'application/json',
                content: JSON.stringify(a),
              },
            },
            {
              text: prompt,
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0,
      },
    });

    const response = fetch(
      'https://llmfoundry.straive.com/gemini/v1beta/models/gemini-2.5-flash-lite:generateContent',
      {
        method: 'POST',
        headers: {
          Authorization:
            'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJlbWFpbCI6ImplZXZhbmFudGhhbS5kdXJhaXNhbXlAc3RyYWl2ZS5jb20ifQ.V68TDdGGo9XoTz6sZlfOoErZC9l5CwQKgny_0TyD1KM:llmproxy-playground',
          'Content-Type': 'application/json',
        },
        body,
      },
    );
    return of(response);
  }

  LLMExtract(rawContent: any) {
    const payload = {
      system_instruction: {
        parts: [
          {
            text: 'You are a helpful assistant',
          },
        ],
      },
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: JSON.stringify(rawContent),
            },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              text: `Analyze the following text and extract JSON with:\n1. employees: latest total employees (numeric, include qualifier if present).\n2. revenue: most recent annual revenue (numeric + currency + fiscal year).\n3. ceo: current CEO full name (mention interim if applicable).`,
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0,
      },
    };

    const httpOptions = {
      headers: new HttpHeaders({
        'Content-Type': 'application/json',
        Authorization:
          'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJlbWFpbCI6ImplZXZhbmFudGhhbS5kdXJhaXNhbXlAc3RyYWl2ZS5jb20ifQ.V68TDdGGo9XoTz6sZlfOoErZC9l5CwQKgny_0TyD1KM:llmproxy-playground',
        // Add any other necessary headers, like API keys if required
      }),
    };

    return this.http.post<any>(this.apiUrl, payload, httpOptions);
  }
}
