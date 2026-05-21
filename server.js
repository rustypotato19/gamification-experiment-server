require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const { Pool } = require("pg");

const app = express();

const PORT = Number(process.env.PORT || 5000);
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("Missing DATABASE_URL in .env");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  // ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

app.use(helmet());
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || true,
    credentials: true,
  }),
);
app.use(express.json({ limit: "256kb" }));

// ---- Helpers ----
function isValidParticipantId(id) {
  return typeof id === "string" && id.length >= 8 && id.length <= 64;
}

function bool(v) {
  return v === true;
}

function isChoice(v) {
  return v === "a" || v === "b" || v === "c";
}

function isIsoDateString(s) {
  return typeof s === "string" && !Number.isNaN(Date.parse(s));
}

async function upsertPreSurveySubmission({
  participantId,
  answers,
  scoreCorrect,
  scoreTotal,
  startedAtISO,
  submittedAtISO,
}) {
  // Optional consent gating (kept from earlier)
  const consentCheck = await pool.query(
    "SELECT consent_given, withdrawn FROM participants WHERE participant_id = $1",
    [participantId],
  );
  if (consentCheck.rowCount === 0) {
    return { ok: false, status: 400, error: "participant_not_registered" };
  }
  const { consent_given, withdrawn } = consentCheck.rows[0];
  if (!consent_given)
    return { ok: false, status: 400, error: "consent_not_given" };
  if (withdrawn)
    return { ok: false, status: 400, error: "participant_withdrawn" };

  const sql = `
    INSERT INTO pre_survey_submissions (
      participant_id,
      answers,
      score_correct,
      score_total,
      started_at,
      submitted_at
    )
    VALUES ($1, $2::char(1)[], $3, $4, $5::timestamptz, $6::timestamptz)
    ON CONFLICT (participant_id)
    DO UPDATE SET
      answers = EXCLUDED.answers,
      score_correct = EXCLUDED.score_correct,
      score_total = EXCLUDED.score_total,
      started_at = EXCLUDED.started_at,
      submitted_at = EXCLUDED.submitted_at
    RETURNING id, participant_id, score_correct, score_total, submitted_at;
  `;

  const result = await pool.query(sql, [
    participantId,
    answers,
    scoreCorrect,
    scoreTotal,
    startedAtISO,
    submittedAtISO,
  ]);

  return { ok: true, row: result.rows[0] };
}

async function assignGroupBalanced(client) {
  // Prevent race conditions when multiple users consent at the same time.
  // Everyone contending for the same lock id will serialize the group assignment.
  await client.query("SELECT pg_advisory_xact_lock(424242)");

  const counts = await client.query(
    `
    SELECT
      SUM(CASE WHEN "group" = 'control' THEN 1 ELSE 0 END)::int AS control_count,
      SUM(CASE WHEN "group" = 'test' THEN 1 ELSE 0 END)::int AS test_count
    FROM participants
    WHERE consent_given = true
      AND withdrawn IS NOT TRUE
    `,
  );

  const controlCount = counts.rows[0]?.control_count ?? 0;
  const testCount = counts.rows[0]?.test_count ?? 0;

  // If even, assign to control
  if (controlCount <= testCount) return "control";
  return "test";
}

// ---- Routes ----
app.get("/api/health", async (_req, res) => {
  try {
    const r = await pool.query("SELECT NOW() as now");
    res.json({ ok: true, now: r.rows[0].now });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "db_unreachable" });
  }
});

/**
 * POST /api/consent
 */
app.post("/api/consent", async (req, res) => {
  const {
    participantId,
    readInfoSheet,
    voluntaryWithdraw,
    age18Plus,
    understoodAndAgree,
    consentTimestamp,
  } = req.body || {};

  if (!isValidParticipantId(participantId)) {
    return res.status(400).json({ ok: false, error: "invalid_participantId" });
  }

  const allTrue =
    bool(readInfoSheet) &&
    bool(voluntaryWithdraw) &&
    bool(age18Plus) &&
    bool(understoodAndAgree);
  if (!allTrue) {
    return res.status(400).json({ ok: false, error: "consent_incomplete" });
  }

  const consentTs =
    typeof consentTimestamp === "string" ? consentTimestamp : null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // If this participant already exists and has a group, keep it.
    const existing = await client.query(
      `SELECT "group" FROM participants WHERE participant_id = $1`,
      [participantId],
    );

    let groupToUse = existing.rowCount > 0 ? existing.rows[0]?.group : null;

    if (groupToUse !== "control" && groupToUse !== "test") {
      groupToUse = await assignGroupBalanced(client);
    }

    const sql = `
      INSERT INTO participants (
        participant_id,
        consent_given,
        consent_timestamp,
        read_info_sheet,
        voluntary_withdraw,
        age_18_plus,
        understood_and_agree,
        "group"
      )
      VALUES (
        $1,
        TRUE,
        COALESCE($2::timestamptz, NOW()),
        TRUE,
        TRUE,
        TRUE,
        TRUE,
        $3
      )
      ON CONFLICT (participant_id)
      DO UPDATE SET
        consent_given = TRUE,
        consent_timestamp = COALESCE(EXCLUDED.consent_timestamp, participants.consent_timestamp),
        read_info_sheet = TRUE,
        voluntary_withdraw = TRUE,
        age_18_plus = TRUE,
        understood_and_agree = TRUE,
        -- keep existing group if already set, otherwise set it now
        "group" = COALESCE(participants."group", EXCLUDED."group")
      RETURNING participant_id, consent_given, consent_timestamp, "group";
    `;

    const result = await client.query(sql, [
      participantId,
      consentTs,
      groupToUse,
    ]);

    await client.query("COMMIT");
    return res.json({ ok: true, participant: result.rows[0] });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(e);
    return res.status(500).json({ ok: false, error: "db_error" });
  } finally {
    client.release();
  }
});

/**
 * POST /api/withdraw
 */
app.post("/api/withdraw", async (req, res) => {
  const { participantId } = req.body || {};

  if (!isValidParticipantId(participantId)) {
    return res.status(400).json({ ok: false, error: "invalid_participantId" });
  }

  const sql = `
    UPDATE participants
    SET withdrawn = TRUE,
        withdrawn_at = NOW()
    WHERE participant_id = $1
    RETURNING participant_id, withdrawn, withdrawn_at;
  `;

  try {
    const result = await pool.query(sql, [participantId]);
    if (result.rowCount === 0) {
      return res
        .status(404)
        .json({ ok: false, error: "participant_not_found" });
    }
    res.json({ ok: true, participant: result.rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "db_error" });
  }
});

/**
 * POST /api/pre-survey
 * Body:
 * {
 *   participantId: string,
 *   answers: ("a"|"b"|"c")[]   // length 15
 *   scoreCorrect: number,
 *   scoreTotal: number,
 *   startedAtISO: string,
 *   submittedAtISO: string
 * }
 */
app.post("/api/pre-survey", async (req, res) => {
  const {
    participantId,
    answers,
    scoreCorrect,
    scoreTotal,
    startedAtISO,
    submittedAtISO,
  } = req.body || {};

  if (!isValidParticipantId(participantId)) {
    return res.status(400).json({ ok: false, error: "invalid_participantId" });
  }
  if (!Array.isArray(answers) || answers.length < 1 || answers.length > 200) {
    return res.status(400).json({ ok: false, error: "invalid_answers" });
  }
  if (!answers.every(isChoice)) {
    return res.status(400).json({ ok: false, error: "answers_must_be_a_b_c" });
  }
  if (
    typeof scoreCorrect !== "number" ||
    typeof scoreTotal !== "number" ||
    !Number.isInteger(scoreCorrect) ||
    !Number.isInteger(scoreTotal) ||
    scoreCorrect < 0 ||
    scoreTotal <= 0 ||
    scoreCorrect > scoreTotal
  ) {
    return res.status(400).json({ ok: false, error: "invalid_score" });
  }
  if (!isIsoDateString(startedAtISO) || !isIsoDateString(submittedAtISO)) {
    return res.status(400).json({ ok: false, error: "invalid_timestamps" });
  }
  if (answers.length !== scoreTotal) {
    return res.status(400).json({
      ok: false,
      error: "answers_length_must_match_scoreTotal",
    });
  }

  try {
    const out = await upsertPreSurveySubmission({
      participantId,
      answers,
      scoreCorrect,
      scoreTotal,
      startedAtISO,
      submittedAtISO,
    });

    if (!out.ok) {
      return res.status(out.status).json({ ok: false, error: out.error });
    }

    return res.json({ ok: true, preSurvey: out.row });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: "db_error" });
  }
});

/**
 * GET /api/pre-survey/:participantId
 * Quick check endpoint
 */
app.get("/api/pre-survey/:participantId", async (req, res) => {
  const { participantId } = req.params;

  if (!isValidParticipantId(participantId)) {
    return res.status(400).json({ ok: false, error: "invalid_participantId" });
  }

  try {
    const r = await pool.query(
      `SELECT participant_id, score_correct, score_total, started_at, submitted_at, created_at
       FROM pre_survey_submissions
       WHERE participant_id = $1`,
      [participantId],
    );

    if (r.rowCount === 0) {
      return res.status(404).json({ ok: false, error: "not_found" });
    }

    res.json({ ok: true, preSurvey: r.rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "db_error" });
  }
});

/**
 * POST /api/surveys
 * Matches your frontend submitSurvey() payload.
 * Currently supports surveyType === "pre".
 * (You can add "post" later with a post_survey_submissions table.)
 */
app.post("/api/surveys", async (req, res) => {
  const {
    surveyType,
    participantId,
    answers,
    scoreCorrect,
    scoreTotal,
    startedAtISO,
    submittedAtISO,
  } = req.body || {};

  if (surveyType !== "pre") {
    return res.status(400).json({ ok: false, error: "unsupported_surveyType" });
  }

  // Reuse the same validations by calling the same helper route logic:
  if (!isValidParticipantId(participantId)) {
    return res.status(400).json({ ok: false, error: "invalid_participantId" });
  }
  if (!Array.isArray(answers) || !answers.every(isChoice)) {
    return res.status(400).json({ ok: false, error: "invalid_answers" });
  }
  if (
    typeof scoreCorrect !== "number" ||
    typeof scoreTotal !== "number" ||
    !Number.isInteger(scoreCorrect) ||
    !Number.isInteger(scoreTotal) ||
    scoreCorrect < 0 ||
    scoreTotal <= 0 ||
    scoreCorrect > scoreTotal
  ) {
    return res.status(400).json({ ok: false, error: "invalid_score" });
  }
  if (!isIsoDateString(startedAtISO) || !isIsoDateString(submittedAtISO)) {
    return res.status(400).json({ ok: false, error: "invalid_timestamps" });
  }
  if (answers.length !== scoreTotal) {
    return res.status(400).json({
      ok: false,
      error: "answers_length_must_match_scoreTotal",
    });
  }

  try {
    const out = await upsertPreSurveySubmission({
      participantId,
      answers,
      scoreCorrect,
      scoreTotal,
      startedAtISO,
      submittedAtISO,
    });

    if (!out.ok) {
      return res.status(out.status).json({ ok: false, error: out.error });
    }

    return res.json({ ok: true, preSurvey: out.row });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: "db_error" });
  }
});

/**
 * GET /api/participant-group/:participantId
 * Returns the participant's assigned group.
 */
app.get("/api/participant-group/:participantId", async (req, res) => {
  const { participantId } = req.params;

  if (!isValidParticipantId(participantId)) {
    return res.status(400).json({ ok: false, error: "invalid_participantId" });
  }

  try {
    const r = await pool.query(
      `SELECT "group" as "exp_group"
       FROM participants
       WHERE participant_id = $1`,
      [participantId],
    );

    if (r.rowCount === 0) {
      return res.status(404).json({ ok: false, error: "not_found" });
    }

    res.json({
      ok: true,
      group: r.rows[0].exp_group, 
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "db_error" });
  }
});

// ---- Start ----
app.listen(PORT, "127.0.0.1", () =>
  console.log(`listening on 127.0.0.1:${PORT}`),
);
