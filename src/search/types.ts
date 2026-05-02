export type SearchResult = {
  title: string;
  url: string;
  snippet: string;
  section: string;
};

export type SearchResponse = {
  results: SearchResult[];
  totalAvailable: number;
};

export type SearchClient = {
  search(query: string, opts?: { version?: string; limit?: number }): Promise<SearchResponse>;
  close?(): void;
};
