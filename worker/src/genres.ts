/** Genres used for filtering catalog entries. */
export const CATALOG_GENRES = [
  "Action",
  "Animation",
  "Comedy",
  "Crime",
  "Drama",
  "Fantasy",
  "Historical",
  "Horror",
  "Mystery",
  "Romance",
  "Science Fiction",
  "Sports",
  "Thriller",
] as const;

export type CatalogGenre = (typeof CATALOG_GENRES)[number];
