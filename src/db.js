import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const projectRoot = path.resolve(__dirname, "..");
export const storageRoot = path.join(projectRoot, "storage");
export const projectsRoot = path.join(storageRoot, "projects");
export const uploadsRoot = path.join(storageRoot, "uploads");
const dbPath = path.join(storageRoot, "longform.db");

fs.mkdirSync(storageRoot, { recursive: true });
fs.mkdirSync(projectsRoot, { recursive: true });
fs.mkdirSync(uploadsRoot, { recursive: true });

const db = new Database(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    platform TEXT NOT NULL,
    upload_webhook_url TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    topic TEXT NOT NULL,
    language TEXT NOT NULL,
    tone TEXT NOT NULL,
    format TEXT NOT NULL,
    channel_id TEXT,
    status TEXT NOT NULL,
    scheduled_at TEXT,
    style_reference_path TEXT,
    bgm_path TEXT,
    watermark_path TEXT,
    settings_json TEXT NOT NULL,
    research_json TEXT,
    style_json TEXT,
    script_text TEXT,
    scenes_json TEXT,
    output_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

function parseJson(value, fallback) {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function mapProject(row) {
  if (!row) {
    return null;
  }

  return {
    ...row,
    settings: parseJson(row.settings_json, {}),
    research: parseJson(row.research_json, null),
    styleProfile: parseJson(row.style_json, null),
    scenes: parseJson(row.scenes_json, []),
    output: parseJson(row.output_json, {})
  };
}

export function listChannels() {
  return db.prepare(`
    SELECT *
    FROM channels
    ORDER BY created_at DESC
  `).all();
}

export function createChannel(channel) {
  db.prepare(`
    INSERT INTO channels (
      id, name, platform, upload_webhook_url, created_at
    ) VALUES (
      @id, @name, @platform, @upload_webhook_url, @created_at
    )
  `).run(channel);
}

export function getChannel(id) {
  return db.prepare(`
    SELECT *
    FROM channels
    WHERE id = ?
  `).get(id);
}

export function createProject(project) {
  db.prepare(`
    INSERT INTO projects (
      id, topic, language, tone, format, channel_id, status, scheduled_at,
      style_reference_path, bgm_path, watermark_path, settings_json, research_json,
      style_json, script_text, scenes_json, output_json, created_at, updated_at
    ) VALUES (
      @id, @topic, @language, @tone, @format, @channel_id, @status, @scheduled_at,
      @style_reference_path, @bgm_path, @watermark_path, @settings_json, @research_json,
      @style_json, @script_text, @scenes_json, @output_json, @created_at, @updated_at
    )
  `).run(project);
}

export function updateProject(id, patch) {
  const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
  if (!entries.length) {
    return;
  }

  const sql = entries.map(([key]) => `${key} = @${key}`).join(", ");
  db.prepare(`
    UPDATE projects
    SET ${sql}
    WHERE id = @id
  `).run({ id, ...patch });
}

export function deleteProject(id) {
  db.prepare(`
    DELETE FROM projects
    WHERE id = ?
  `).run(id);
}

export function getProject(id) {
  const row = db.prepare(`
    SELECT p.*, c.name AS channel_name, c.platform AS channel_platform, c.upload_webhook_url AS channel_webhook
    FROM projects p
    LEFT JOIN channels c ON c.id = p.channel_id
    WHERE p.id = ?
  `).get(id);

  return mapProject(row);
}

export function listProjects() {
  const rows = db.prepare(`
    SELECT p.*, c.name AS channel_name, c.platform AS channel_platform, c.upload_webhook_url AS channel_webhook
    FROM projects p
    LEFT JOIN channels c ON c.id = p.channel_id
    ORDER BY p.created_at DESC
  `).all();

  return rows.map(mapProject);
}

export function listDueUploads(nowIso) {
  return listProjects().filter((project) => {
    if (!project.scheduled_at) {
      return false;
    }

    const output = project.output ?? {};
    const uploadStatus = output.uploadStatus ?? "pending";

    return (
      project.status === "ready" &&
      uploadStatus !== "uploaded" &&
      uploadStatus !== "uploading" &&
      new Date(project.scheduled_at).getTime() <= new Date(nowIso).getTime() &&
      Boolean(project.channel_webhook)
    );
  });
}
