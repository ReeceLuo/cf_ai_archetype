export type RecommendationCard = {
  id: string;
  characterName: string;
  workTitle: string;
  workType: "movie" | "tv";
  blurb: string;
  rationale: string;
  imageUrl?: string;
  genres?: string[];
};

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  cards?: RecommendationCard[];
};

export type RecommendationInput = {
  inputMode: "mbti" | "traits";
  mbti?: string;
  traits?: string;
  genre: string;
};

export type WorkflowParams = {
  sessionId: string;
  userMessage: string;
  history: ChatMessage[];
  recommendation?: RecommendationInput;
};

export type RecommendationMatchMode = "similar" | "contrast";

export type ExtractIntentResult = {
  searchQuery: string;
  contextNotes?: string;
  genre?: string;
  excludeSubjects?: string[];
  matchMode?: RecommendationMatchMode;
  needsRecommendation?: boolean;
};

export type RetrievedCharacter = {
  id: string;
  workTitle: string;
  workType: "movie" | "tv";
  characterName: string;
  blurb: string;
  imageUrl?: string;
  genres?: string[];
  score?: number;
};

export type WorkflowResult = {
  reply: string;
  cards: RecommendationCard[];
};
