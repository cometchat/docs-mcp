export type SearchResult = {
  title: string;
  url: string;
  snippet: string;
  section: string;
  /** Version picker label of the page's product, e.g. "v7"; absent when unversioned. */
  version?: string;
  /** False when the page documents an older version of its product. */
  isCurrent: boolean;
};

export type SearchResponse = {
  results: SearchResult[];
  totalAvailable: number;
};

export type SearchClient = {
  search(query: string, opts?: { version?: string; limit?: number }): Promise<SearchResponse>;
  close?(): void;
};
