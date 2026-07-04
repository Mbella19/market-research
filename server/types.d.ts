declare module "google-play-scraper" {
  const gplay: {
    search(opts: { term: string; num?: number; lang?: string; country?: string }): Promise<unknown[]>;
    reviews(opts: {
      appId: string;
      sort?: number;
      num?: number;
      lang?: string;
      country?: string;
    }): Promise<{ data: unknown[] }>;
    sort: { NEWEST: number; RATING: number; HELPFULNESS: number };
  };
  export default gplay;
}
