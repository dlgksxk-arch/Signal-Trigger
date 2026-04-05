import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import express from "express";
import multer from "multer";
import { config } from "dotenv";
import { randomUUID } from "node:crypto";
import {
  createChannel,
  createProject,
  getProject,
  listChannels,
  listDueUploads,
  listProjects,
  projectRoot,
  updateProject,
  uploadsRoot
} from "./db.js";
import { askProjectHelp, runProject } from "./pipeline.js";
import { fetchTrendIdeas, generateScript } from "./services/content.js";
import { getVersionLabel } from "./version.js";

config();

const port = Number(process.env.PORT || 3000);
const appBaseUrl = process.env.APP_BASE_URL || `http://localhost:${port}`;
const versionLabel = getVersionLabel();
const workflowOrder = ["topic", "research", "script", "scenes", "render", "publish"];

export function createApp() {
  const app = express();
  const upload = multer({ dest: uploadsRoot });

  app.set("view engine", "ejs");
  app.set("views", path.join(projectRoot, "views"));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use("/public", express.static(path.join(projectRoot, "public")));
  app.use("/storage", express.static(path.join(projectRoot, "storage")));

  app.get("/", (_req, res) => {
    res.render("index", {
      channels: listChannels(),
      projects: listProjects(),
      versionLabel
    });
  });

  app.get("/projects/:id", (req, res) => {
    renderProjectPage(res, req.params.id, req.query.step);
  });

  app.post("/channels", (req, res) => {
    createChannel({
      id: randomUUID(),
      name: req.body.name?.trim() || "기본 채널",
      platform: req.body.platform?.trim() || "youtube",
      upload_webhook_url: req.body.uploadWebhookUrl?.trim() || null,
      created_at: new Date().toISOString()
    });

    res.redirect("/");
  });

  app.post(
    "/projects",
    upload.fields([
      { name: "styleReference", maxCount: 1 },
      { name: "bgmFile", maxCount: 1 },
      { name: "watermarkFile", maxCount: 1 }
    ]),
    (req, res) => {
      const files = req.files;
      const id = randomUUID();
      const now = new Date().toISOString();

      createProject({
        id,
        topic: req.body.topic?.trim() || "새 롱폼 프로젝트",
        language: req.body.language?.trim() || "ko",
        tone: req.body.tone?.trim() || "정보형",
        format: req.body.format?.trim() || "portrait",
        channel_id: req.body.channelId?.trim() || null,
        status: "draft",
        scheduled_at: req.body.scheduledAt?.trim() || null,
        style_reference_path: files?.styleReference?.[0]?.path || null,
        bgm_path: files?.bgmFile?.[0]?.path || null,
        watermark_path: files?.watermarkFile?.[0]?.path || null,
        settings_json: JSON.stringify({
          customPrompt: req.body.customPrompt?.trim() || "",
          bgmEnabled: Boolean(files?.bgmFile?.[0]?.path),
          watermarkEnabled: Boolean(files?.watermarkFile?.[0]?.path),
          styleConsistency: Boolean(files?.styleReference?.[0]?.path)
        }),
        research_json: null,
        style_json: null,
        script_text: null,
        scenes_json: JSON.stringify([]),
        output_json: JSON.stringify({ uploadStatus: "pending" }),
        created_at: now,
        updated_at: now
      });

      res.redirect(`/projects/${id}?step=topic`);
    }
  );

  app.post("/projects/:id/settings", (req, res) => {
    const project = getProject(req.params.id);
    if (!project) {
      res.status(404).send("프로젝트를 찾을 수 없습니다.");
      return;
    }

    updateProject(project.id, {
      topic: req.body.topic?.trim() || project.topic,
      language: req.body.language?.trim() || project.language,
      tone: req.body.tone?.trim() || project.tone,
      format: req.body.format?.trim() || project.format,
      channel_id: req.body.channelId?.trim() || null,
      scheduled_at: req.body.scheduledAt?.trim() || null,
      updated_at: new Date().toISOString(),
      settings_json: JSON.stringify({
        ...(project.settings ?? {}),
        customPrompt: req.body.customPrompt?.trim() || ""
      })
    });

    res.redirect(`/projects/${project.id}?step=topic`);
  });

  app.post("/projects/:id/bootstrap", async (req, res) => {
    const project = getProject(req.params.id);
    if (!project) {
      res.status(404).send("프로젝트를 찾을 수 없습니다.");
      return;
    }

    try {
      const research = await fetchTrendIdeas(project.topic, project.language);
      const script = await generateScript({
        topic: project.topic,
        tone: project.tone,
        language: project.language,
        research,
        customPrompt: project.settings?.customPrompt || ""
      });

      updateProject(project.id, {
        updated_at: new Date().toISOString(),
        research_json: JSON.stringify(research),
        script_text: script
      });

      res.redirect(`/projects/${project.id}?step=script`);
    } catch (error) {
      res.status(500).send(error instanceof Error ? error.message : "자동 초안 생성 실패");
    }
  });

  app.post("/projects/:id/research/auto", async (req, res) => {
    const project = getProject(req.params.id);
    if (!project) {
      res.status(404).send("프로젝트를 찾을 수 없습니다.");
      return;
    }

    try {
      const research = await fetchTrendIdeas(project.topic, project.language);
      updateProject(project.id, {
        updated_at: new Date().toISOString(),
        research_json: JSON.stringify({
          ...research,
          manualNotes: project.research?.manualNotes || ""
        })
      });

      res.redirect(`/projects/${project.id}?step=research`);
    } catch (error) {
      res.status(500).send(error instanceof Error ? error.message : "리서치 자동 수집 실패");
    }
  });

  app.post("/projects/:id/research/manual", (req, res) => {
    const project = getProject(req.params.id);
    if (!project) {
      res.status(404).send("프로젝트를 찾을 수 없습니다.");
      return;
    }

    const manualResearch = {
      source: project.research?.source || "manual",
      summary: req.body.summary?.trim() || "",
      ideas: splitLines(req.body.ideas),
      manualNotes: req.body.manualNotes?.trim() || ""
    };

    updateProject(project.id, {
      updated_at: new Date().toISOString(),
      research_json: JSON.stringify(manualResearch)
    });

    res.redirect(`/projects/${project.id}?step=research`);
  });

  app.post("/projects/:id/script/auto", async (req, res) => {
    const project = getProject(req.params.id);
    if (!project) {
      res.status(404).send("프로젝트를 찾을 수 없습니다.");
      return;
    }

    try {
      const research = project.research ?? await fetchTrendIdeas(project.topic, project.language);
      const script = await generateScript({
        topic: project.topic,
        tone: project.tone,
        language: project.language,
        research,
        customPrompt: project.settings?.customPrompt || ""
      });

      updateProject(project.id, {
        updated_at: new Date().toISOString(),
        research_json: JSON.stringify(research),
        script_text: script
      });

      res.redirect(`/projects/${project.id}?step=script`);
    } catch (error) {
      res.status(500).send(error instanceof Error ? error.message : "대본 자동 생성 실패");
    }
  });

  app.post("/projects/:id/script/manual", (req, res) => {
    const project = getProject(req.params.id);
    if (!project) {
      res.status(404).send("프로젝트를 찾을 수 없습니다.");
      return;
    }

    updateProject(project.id, {
      updated_at: new Date().toISOString(),
      script_text: req.body.script?.trim() || ""
    });

    res.redirect(`/projects/${project.id}?step=script`);
  });

  app.post("/projects/:id/run", async (req, res) => {
    try {
      await runProject(req.params.id);
      res.redirect(`/projects/${req.params.id}?step=render`);
    } catch (error) {
      res.status(500).send(error instanceof Error ? error.message : "실행 실패");
    }
  });

  app.post("/projects/:id/scenes/:sceneIndex/regenerate", async (req, res) => {
    try {
      await runProject(req.params.id, {
        regenerateSceneIndex: Number(req.params.sceneIndex)
      });
      res.redirect(`/projects/${req.params.id}?step=scenes`);
    } catch (error) {
      res.status(500).send(error instanceof Error ? error.message : "장면 재생성 실패");
    }
  });

  app.post("/projects/:id/help", (req, res) => {
    try {
      const answer = askProjectHelp(req.params.id, req.body.question || "");
      renderProjectPage(res, req.params.id, "publish", answer);
    } catch (error) {
      res.status(500).send(error instanceof Error ? error.message : "도움말 실패");
    }
  });

  app.get("/api/upload-ready", (_req, res) => {
    const items = listDueUploads(new Date().toISOString()).map((project) => ({
      id: project.id,
      topic: project.topic,
      channelName: project.channel_name,
      webhookUrl: project.channel_webhook,
      scheduledAt: project.scheduled_at,
      payloadUrl: `${appBaseUrl}/api/projects/${project.id}/upload-payload`
    }));

    res.json(items);
  });

  app.get("/api/projects/:id/upload-payload", (req, res) => {
    const project = getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: "프로젝트를 찾을 수 없습니다." });
      return;
    }

    res.json({
      id: project.id,
      topic: project.topic,
      language: project.language,
      scheduledAt: project.scheduled_at,
      channel: {
        id: project.channel_id,
        name: project.channel_name,
        platform: project.channel_platform
      },
      files: {
        videoUrl: toPublicStorageUrl(project.output?.videoPath),
        thumbnailUrl: toPublicStorageUrl(project.output?.thumbnailPath),
        subtitlesUrl: toPublicStorageUrl(project.output?.subtitlesPath)
      }
    });
  });

  app.get("/api/projects/:id/google-vids-package", (req, res) => {
    const project = getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: "프로젝트를 찾을 수 없습니다." });
      return;
    }

    res.json({
      version: versionLabel,
      topic: project.topic,
      language: project.language,
      script: project.script_text,
      narrationUrl: toPublicStorageUrl(project.output?.narrationPath),
      subtitleUrl: toPublicStorageUrl(project.output?.subtitlesPath),
      videoUrl: toPublicStorageUrl(project.output?.videoPath),
      thumbnailUrl: toPublicStorageUrl(project.output?.thumbnailPath),
      scenes: (project.scenes ?? []).map((scene) => ({
        title: scene.title,
        narration: scene.narration,
        imageUrl: toPublicStorageUrl(scene.imagePath)
      })),
      notes: [
        "Google Vids 직접 생성 API는 확인되지 않았습니다.",
        "현재 구조는 MP4와 자산 묶음을 만들어 Google Drive 또는 Google Vids 수동 가져오기에 맞춘 형태입니다.",
        "Slides를 먼저 만든 뒤 Google Vids로 변환하는 흐름도 별도 자동화 후보입니다."
      ]
    });
  });

  app.post("/api/projects/:id/mark-uploaded", (req, res) => {
    const project = getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: "프로젝트를 찾을 수 없습니다." });
      return;
    }

    updateProject(project.id, {
      updated_at: new Date().toISOString(),
      output_json: JSON.stringify({
        ...(project.output ?? {}),
        uploadStatus: "uploaded",
        uploadedAt: new Date().toISOString()
      })
    });

    res.json({ ok: true });
  });

  return app;
}

export function startServer() {
  const app = createApp();
  app.listen(port, () => {
    console.log(`Longform Factory running on ${appBaseUrl}`);
    startUploadScheduler();
  });
}

function renderProjectPage(res, projectId, requestedStep, helpAnswer) {
  const project = getProject(projectId);
  if (!project) {
    res.status(404).send("프로젝트를 찾을 수 없습니다.");
    return;
  }

  const activeStep = normalizeStep(requestedStep);
  const steps = buildWorkflowSteps(project, activeStep);

  res.render("project", {
    project,
    activeStep,
    steps,
    channels: listChannels(),
    versionLabel,
    helpAnswer,
    researchIdeasText: (project.research?.ideas ?? []).join("\n"),
    researchSummaryText: project.research?.summary ?? "",
    researchNotesText: project.research?.manualNotes ?? "",
    googleVidsNotes: [
      "공식 문서 기준으로 Google Vids는 Drive 비디오를 편집하고 MP4로 다운로드할 수 있습니다.",
      "공식 개발자 문서에서는 Google Vids를 MP4로 내보내는 형식만 확인됐고, 생성/편집 API는 확인되지 않았습니다.",
      "그래서 현재 프로젝트는 MP4, 자막, 장면 이미지 묶음을 만들어 Vids 수동 가져오기 또는 Drive 기반 후속 작업에 맞췄습니다."
    ],
    githubStatus: {
      localGitReady: true,
      remoteConnected: false,
      note: "로컬 Git은 준비했지만 GitHub 앱 설치 저장소가 아직 없어 원격 연결은 대기 상태입니다."
    }
  });
}

function buildWorkflowSteps(project, activeStep) {
  const scenesReady = Array.isArray(project.scenes) && project.scenes.length > 0;
  const videoReady = Boolean(project.output?.videoPath);

  const statusMap = {
    topic: Boolean(project.topic),
    research: Boolean(project.research?.ideas?.length || project.research?.summary),
    script: Boolean(project.script_text),
    scenes: scenesReady,
    render: videoReady,
    publish: videoReady
  };

  return workflowOrder.map((step) => ({
    key: step,
    label: stepLabel(step),
    shortLabel: stepShortLabel(step),
    href: `/projects/${project.id}?step=${step}`,
    active: activeStep === step,
    done: statusMap[step]
  }));
}

function stepLabel(step) {
  const labels = {
    topic: "1. 주제 설정",
    research: "2. 소재 발굴",
    script: "3. 대본 작성",
    scenes: "4. 장면 편집",
    render: "5. 렌더링",
    publish: "6. 업로드"
  };

  return labels[step];
}

function stepShortLabel(step) {
  const labels = {
    topic: "주제",
    research: "리서치",
    script: "대본",
    scenes: "장면",
    render: "렌더",
    publish: "업로드"
  };

  return labels[step];
}

function normalizeStep(step) {
  return workflowOrder.includes(step) ? step : "topic";
}

function splitLines(value) {
  return (value || "")
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function toPublicStorageUrl(filePath) {
  if (!filePath) {
    return null;
  }

  const relative = path.relative(path.join(projectRoot, "storage"), filePath).replace(/\\/g, "/");
  return `${appBaseUrl}/storage/${relative}`;
}

function startUploadScheduler() {
  setInterval(async () => {
    const dueProjects = listDueUploads(new Date().toISOString());

    for (const project of dueProjects) {
      try {
        updateProject(project.id, {
          updated_at: new Date().toISOString(),
          output_json: JSON.stringify({
            ...(project.output ?? {}),
            uploadStatus: "uploading"
          })
        });

        const payload = await fetch(`${appBaseUrl}/api/projects/${project.id}/upload-payload`).then((response) => response.json());
        const response = await fetch(project.channel_webhook, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });

        if (!response.ok) {
          throw new Error(`웹훅 업로드 실패: ${response.status}`);
        }

        updateProject(project.id, {
          updated_at: new Date().toISOString(),
          output_json: JSON.stringify({
            ...(project.output ?? {}),
            uploadStatus: "uploaded",
            uploadedAt: new Date().toISOString()
          })
        });
      } catch (error) {
        const latest = getProject(project.id);
        updateProject(project.id, {
          updated_at: new Date().toISOString(),
          output_json: JSON.stringify({
            ...(latest?.output ?? {}),
            uploadStatus: "failed",
            uploadError: error instanceof Error ? error.message : "업로드 실패"
          })
        });
      }
    }
  }, 60_000);
}

const isDirectRun = process.argv[1] && pathToFileURL(fileURLToPath(import.meta.url)).href === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  startServer();
}
