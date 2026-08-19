import { query, pool } from './index.js';
export async function initSchema() {
    console.log('[DB] Initializing Aiven MySQL schema...');
    await query(`
    CREATE TABLE IF NOT EXISTS jobs_state (
      job_id VARCHAR(255) PRIMARY KEY,
      status VARCHAR(50) NOT NULL DEFAULT 'pending',
      current_checkpoint TEXT,
      last_updated TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);
    await query(`
    CREATE TABLE IF NOT EXISTS predictions (
      id VARCHAR(36) PRIMARY KEY,
      session_id VARCHAR(255),
      event_date DATE,
      sport VARCHAR(100) DEFAULT 'football',
      fixture VARCHAR(500) NOT NULL,
      league VARCHAR(255),
      prediction_market VARCHAR(500) NOT NULL,
      goal_statement TEXT,
      probability DECIMAL(5,2),
      confidence_score DECIMAL(5,2),
      star_rating TINYINT DEFAULT 0 COMMENT '1-5 star confidence tier',
      recommended_odds DECIMAL(8,3),
      expected_value DECIMAL(8,4) COMMENT 'EV = (prob * odds) - 1',
      closing_line_value DECIMAL(8,4),
      status VARCHAR(50) NOT NULL DEFAULT 'pending',
      raw_analysis LONGTEXT,
      react_trace JSON,
      feature_snapshot JSON,
      model_weights JSON COMMENT 'Ensemble model weighting used',
      monte_carlo_variance DECIMAL(8,4),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_status (status),
      INDEX idx_created (created_at)
    )
  `);
    // All 80 features across 6 categories
    await query(`
    CREATE TABLE IF NOT EXISTS feature_vectors (
      id VARCHAR(36) PRIMARY KEY,
      prediction_id VARCHAR(36),

      -- Category 1: Team Macro & Advanced Efficiency (1-15)
      net_efficiency_home DECIMAL(6,3),
      net_efficiency_away DECIMAL(6,3),
      true_shooting_pct_home DECIMAL(5,3),
      true_shooting_pct_away DECIMAL(5,3),
      efg_pct_home DECIMAL(5,3),
      efg_pct_away DECIMAL(5,3),
      pace_factor_home DECIMAL(6,2),
      pace_factor_away DECIMAL(6,2),
      turnover_rate_home DECIMAL(5,3),
      turnover_rate_away DECIMAL(5,3),
      oreb_pct_home DECIMAL(5,3),
      oreb_pct_away DECIMAL(5,3),
      dreb_pct_home DECIMAL(5,3),
      dreb_pct_away DECIMAL(5,3),
      free_throw_rate_home DECIMAL(5,3),
      free_throw_rate_away DECIMAL(5,3),
      strength_of_schedule_home DECIMAL(6,3),
      strength_of_schedule_away DECIMAL(6,3),
      pythagorean_expectation_home DECIMAL(5,4),
      pythagorean_expectation_away DECIMAL(5,4),
      home_net_rating DECIMAL(6,3),
      away_net_rating DECIMAL(6,3),
      rest_days_home TINYINT,
      rest_days_away TINYINT,
      rest_advantage TINYINT COMMENT 'home_rest - away_rest',
      schedule_density_home TINYINT COMMENT 'games in last 7 days',
      schedule_density_away TINYINT,
      travel_km_home DECIMAL(8,1),
      travel_km_away DECIMAL(8,1),
      timezone_changes_home TINYINT,
      timezone_changes_away TINYINT,
      clutch_net_rating_home DECIMAL(6,3),
      clutch_net_rating_away DECIMAL(6,3),
      first_half_scoring_avg_home DECIMAL(5,2),
      first_half_scoring_avg_away DECIMAL(5,2),
      second_half_scoring_avg_home DECIMAL(5,2),
      second_half_scoring_avg_away DECIMAL(5,2),

      -- Category 2: Micro Player Matchups & Tracking (16-35)
      star_player_usg_home DECIMAL(5,3),
      star_player_usg_away DECIMAL(5,3),
      top_player_per_home DECIMAL(6,2),
      top_player_per_away DECIMAL(6,2),
      vorp_home DECIMAL(6,3),
      vorp_away DECIMAL(6,3),
      bpm_home DECIMAL(6,3),
      bpm_away DECIMAL(6,3),
      on_off_differential_home DECIMAL(6,3),
      on_off_differential_away DECIMAL(6,3),
      primary_defender_rating_home DECIMAL(6,3),
      primary_defender_rating_away DECIMAL(6,3),
      isolation_efficiency_home DECIMAL(5,3),
      isolation_efficiency_away DECIMAL(5,3),
      pnr_efficiency_home DECIMAL(5,3),
      pnr_efficiency_away DECIMAL(5,3),
      spot_up_efg_home DECIMAL(5,3),
      spot_up_efg_away DECIMAL(5,3),
      rim_protection_home DECIMAL(5,3),
      rim_protection_away DECIMAL(5,3),
      foul_trouble_risk_home DECIMAL(5,3),
      foul_trouble_risk_away DECIMAL(5,3),
      secondary_scorer_variance_home DECIMAL(5,3),
      secondary_scorer_variance_away DECIMAL(5,3),
      matchup_history_h2h_score DECIMAL(6,3),
      speed_distance_home DECIMAL(6,2),
      speed_distance_away DECIMAL(6,2),
      free_throw_pressure_drop_home DECIMAL(5,3),
      free_throw_pressure_drop_away DECIMAL(5,3),
      player_data JSON COMMENT 'Full player-level breakdown JSON',

      -- Category 3: Injury Reports & Lineup Volatility (36-45)
      injury_severity_index_home DECIMAL(5,3) COMMENT '0=none,1=full squad,10=star out',
      injury_severity_index_away DECIMAL(5,3),
      minutes_restriction_home VARCHAR(500) COMMENT 'CSV of restricted players',
      minutes_restriction_away VARCHAR(500),
      lineup_net_rating_home DECIMAL(6,3),
      lineup_net_rating_away DECIMAL(6,3),
      depth_dropoff_home DECIMAL(6,3),
      depth_dropoff_away DECIMAL(6,3),
      late_scratch_frequency_home DECIMAL(5,3),
      late_scratch_frequency_away DECIMAL(5,3),
      gtd_probability_home DECIMAL(5,3),
      gtd_probability_away DECIMAL(5,3),
      reintegration_drag_home DECIMAL(5,3),
      reintegration_drag_away DECIMAL(5,3),
      coaching_rotation_rigidity_home DECIMAL(5,3),
      coaching_rotation_rigidity_away DECIMAL(5,3),
      ejection_risk_home DECIMAL(5,3),
      ejection_risk_away DECIMAL(5,3),
      load_management_index_home DECIMAL(5,3),
      load_management_index_away DECIMAL(5,3),
      injuries_json JSON,

      -- Category 4: Sentiment, News & External (46-60)
      beat_writer_sentiment_home DECIMAL(4,3) COMMENT '-1 to +1',
      beat_writer_sentiment_away DECIMAL(4,3),
      locker_room_disruption_home DECIMAL(5,3),
      locker_room_disruption_away DECIMAL(5,3),
      weather_wind_speed DECIMAL(6,2),
      weather_precipitation DECIMAL(6,2),
      altitude_meters DECIMAL(6,1),
      surface_condition_score DECIMAL(4,3),
      referee_foul_rate DECIMAL(5,3),
      referee_home_bias DECIMAL(4,3),
      motivational_spot_home DECIMAL(4,3) COMMENT 'revenge/trap game factor',
      motivational_spot_away DECIMAL(4,3),
      playoff_urgency_home DECIMAL(4,3),
      playoff_urgency_away DECIMAL(4,3),
      crowd_energy_index DECIMAL(4,3),
      social_distraction_index_home DECIMAL(4,3),
      social_distraction_index_away DECIMAL(4,3),
      coaching_matchup_advantage DECIMAL(4,3) COMMENT '+1 home advantage',
      second_half_adjustment_home DECIMAL(5,3),
      second_half_adjustment_away DECIMAL(5,3),
      national_tv_performance_home DECIMAL(4,3),
      national_tv_performance_away DECIMAL(4,3),

      -- Category 5: Market Dynamics & Sharp Money (61-75)
      opening_line VARCHAR(50),
      current_line VARCHAR(50),
      line_delta DECIMAL(6,3),
      public_betting_pct DECIMAL(5,2) COMMENT '% tickets on home',
      handle_pct DECIMAL(5,2) COMMENT '% money on home (sharp indicator)',
      reverse_line_movement TINYINT(1) DEFAULT 0 COMMENT 'sharp signal',
      key_number_proximity DECIMAL(4,2),
      closing_line_value_projected DECIMAL(6,4),
      implied_prob_home DECIMAL(5,4),
      true_prob_home DECIMAL(5,4),
      value_edge_home DECIMAL(6,4) COMMENT 'true_prob - implied_prob',
      alt_line_variance DECIMAL(6,4),
      live_odds_volatility DECIMAL(5,3),
      market_overreaction_index DECIMAL(4,3),
      arbitrage_gap DECIMAL(6,4),
      prop_inefficiency_score DECIMAL(5,3),
      best_available_odds DECIMAL(8,3),
      bookmaker_variance DECIMAL(6,4),
      odds_data JSON,

      -- Category 6: Meta-Modeling (76-80)
      monte_carlo_home_win DECIMAL(5,4),
      monte_carlo_draw DECIMAL(5,4),
      monte_carlo_away_win DECIMAL(5,4),
      monte_carlo_std_dev DECIMAL(6,4),
      ensemble_regression_weight DECIMAL(4,3),
      ensemble_neural_weight DECIMAL(4,3),
      ensemble_tree_weight DECIMAL(4,3),
      overfit_penalty DECIMAL(4,3),
      self_correction_delta DECIMAL(6,4),
      confidence_tier TINYINT COMMENT '1-5 stars',

      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (prediction_id) REFERENCES predictions(id) ON DELETE CASCADE
    )
  `);
    await query(`
    CREATE TABLE IF NOT EXISTS conversations (
      id VARCHAR(36) PRIMARY KEY,
      session_id VARCHAR(255) NOT NULL,
      channel VARCHAR(50) DEFAULT 'web',
      role VARCHAR(20) NOT NULL,
      content LONGTEXT NOT NULL,
      metadata JSON,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_session (session_id, created_at)
    )
  `);
    await query(`
    CREATE TABLE IF NOT EXISTS booking_log (
      id VARCHAR(36) PRIMARY KEY,
      prediction_id VARCHAR(36),
      platform VARCHAR(50) NOT NULL,
      fixture VARCHAR(500) NOT NULL,
      market VARCHAR(500),
      selection VARCHAR(500),
      odds_obtained DECIMAL(8,3),
      stake_amount DECIMAL(10,2),
      potential_return DECIMAL(10,2),
      bet_id VARCHAR(255),
      betslip_ref VARCHAR(255),
      confirmation_text TEXT,
      success TINYINT(1) DEFAULT 0,
      error_msg TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_prediction (prediction_id),
      INDEX idx_created (created_at)
    )
  `);
    // Add new columns to predictions table if they don't exist yet (idempotent migrations)
    const newCols = [
        ['closing_odds', "DECIMAL(8,3)    COMMENT 'market closing odds for our selection'"],
        ['actual_result', "VARCHAR(100)    COMMENT 'home_win|draw|away_win|btts_yes|over|under'"],
        ['clv_achieved', "DECIMAL(8,4)    COMMENT 'closing line value: positive = beat the close'"],
        ['roi', "DECIMAL(8,4)    COMMENT 'odds-1 if won, -1 if lost, 0 if void'"],
        ['data_completeness_score', "DECIMAL(5,1)    COMMENT '0-100 how much signal was gathered'"],
    ];
    for (const [col, def] of newCols) {
        try {
            await pool.execute(`ALTER TABLE predictions ADD COLUMN ${col} ${def}`);
        }
        catch (e) {
            // Column already exists — silently ignore ER_DUP_FIELDNAME (1060)
            const code = e.code;
            if (code !== 'ER_DUP_FIELDNAME')
                throw e;
        }
    }
    await query(`
    CREATE TABLE IF NOT EXISTS model_feedback (
      id VARCHAR(36) PRIMARY KEY,
      prediction_id VARCHAR(36),
      feature_weights_before JSON,
      feature_weights_after JSON,
      clv_achieved DECIMAL(6,4),
      accuracy_delta DECIMAL(6,4),
      correction_applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
    console.log('[DB] Aiven MySQL schema ready — all 80 feature columns initialized.');
}
//# sourceMappingURL=schema.js.map