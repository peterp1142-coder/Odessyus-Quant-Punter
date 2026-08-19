export interface ReActStep {
  type: 'thought' | 'action' | 'observation' | 'synthesis' | 'error' | 'status';
  content: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  iteration?: number;
  timestamp?: string;
}

export interface PredictionMetadata {
  fixture: string;
  sport: string;
  market: string;
  probability: number;
  confidence: number;
  starRating: number;
  expectedValue: number;
  recommendedOdds: number;
  goalStatement: string;
  monteCarlo: { home: number; draw: number; away: number; stdDev: number };
  subagentResults: { odds: boolean; form: boolean; injury: boolean; sentiment: boolean };
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  steps?: ReActStep[];
  predictionId?: string;
  isStreaming?: boolean;
  metadata?: PredictionMetadata;
}

export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
}

export interface Prediction {
  id: string;
  session_id?: string;
  event_date?: string;
  sport?: string;
  fixture: string;
  league?: string;
  prediction_market: string;
  goal_statement?: string;
  probability?: number;
  confidence_score?: number;
  recommended_odds?: number;
  status: 'pending' | 'won' | 'lost' | 'void';
  raw_analysis?: string;
  react_trace?: ReActStep[];
  feature_vectors?: Record<string, unknown>;
  created_at: string;
  updated_at?: string;
}

export interface Stats {
  total: number;
  won: number;
  lost: number;
  pending: number;
  win_rate_pct: number | null;
  avg_probability?: number;
  avg_confidence?: number;
}

export interface StatsResponse {
  overall: Stats;
  recent: Prediction[];
  daily: { date: string; total: number; won: number; lost: number }[];
}

export type AppView = 'chat' | 'predictions' | 'stats';

export interface StreamEvent {
  type: 'connected' | 'step' | 'complete' | 'saved' | 'error';
  data: unknown;
}
