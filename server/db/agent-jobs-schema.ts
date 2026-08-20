import { query } from './index.js';

export async function initAgentJobsSchema() {
  await query(`CREATE TABLE IF NOT EXISTS agent_jobs (
    id VARCHAR(36) PRIMARY KEY,
    session_id VARCHAR(255) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'queued',
    steps JSON,
    result JSON,
    prediction_id VARCHAR(36),
    error TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_agent_jobs_session(session_id, created_at),
    INDEX idx_agent_jobs_status(status, updated_at)
  )`);
}
