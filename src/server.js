import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import express from "express";
import multer from "multer";
import { config } from "dotenv";
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
import {
  deriveTopicFromPrompt,
  fetchTrendIdeas,
  generateScript,
  isInstructionLikeTopic,
  isWeakResolvedTopic
} from "./services/content.js";
import { getVersionLabel } from "./version.js";

config();

const port = Number(process.env.PORT || 3000);
const appBaseUrl = process.env.APP_BASE_URL || `http://localhost:${port}`;
const versionLabel = getVersionLabel();
const homeSections = ["dashboard", "create", "channels", "projects"];
const workflowOrder = ["topic", "research", "script", "scenes", "render", "publish"];
const durationOptions = [1, 3, 5, 8, 10, 12, 15];

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
    renderHomePage(res, "dashboard");
  });

  app.get("/workspace/:section", (req, res) => {
    renderHomePage(res, req.params.section);
  });

  app.get("/projects/:id/:step", async (req, res) => {
    await hydrateProjectById(req.params.id);
    renderProjectPage(res, req.params.id, req.params.step, undefined, req.query.notice);
  });

  app.get("/projects/:id", async (req, res) => {
    await hydrateProjectById(req.params.id);
    renderProjectPage(res, req.params.id, req.query.step, undefined, req.query.notice);
  });

  app.post("/channels", (req, res) => {
    createChannel({
      id: randomUUID(),
      name: req.body.name?.trim() || "기본 채널",
      platform: req.body.platform?.trim() || "youtube",
      upload_webhook_url: req.body.uploadWebhookUrl?.trim() || null,
      created_at: new Date().toISOString()
    });

    res.redirect("/workspace/channels");
  });

  app.post(
    "/projects",
    upload.fields([
      { name: "styleReference", maxCount: 1 },
      { name: "bgmFile", maxCount: 1 },
      { name: "watermarkFile", maxCount: 1 }
    ]),
    async (req, res) => {
      const files = req.files;
      const id = randomUUID();
      const now = new Date().toISOString();
      const durationMinutes = parseDurationMinutes(req.body.durationMinutes, 10);
      const topicPrompt = normalizeTopicPrompt(req.body.topicPrompt || req.body.topic);
      const language = req.body.language?.trim() || "ko";
      const tone = req.body.tone?.trim() || "정보형";
      const resolvedTopic = await resolveTopicFromInput({
        topicPrompt,
        language,
        tone
      });

      createProject({
        id,
        topic: resolvedTopic,
        language,
        tone,
        format: req.body.format?.trim() || "portrait",
        channel_id: req.body.channelId?.trim() || null,
        status: "draft",
        scheduled_at: req.body.scheduledAt?.trim() || null,
        style_reference_path: files?.styleReference?.[0]?.path || null,
        bgm_path: files?.bgmFile?.[0]?.path || null,
        watermark_path: files?.watermarkFile?.[0]?.path || null,
        settings_json: JSON.stringify({
          topicPrompt,
          customPrompt: req.body.customPrompt?.trim() || "",
          durationMinutes,
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

      res.redirect(`/projects/${id}/topic?notice=project-created`);
    }
  );

  app.post("/projects/:id/settings", async (req, res) => {
    const project = getProject(req.params.id);
    if (!project) {
      res.status(404).send("프로젝트를 찾을 수 없습니다.");
      return;
    }

    const durationMinutes = parseDurationMinutes(req.body.durationMinutes, project.settings?.durationMinutes || 10);
    const topicPrompt = normalizeTopicPrompt(
      req.body.topicPrompt || req.body.topic || project.settings?.topicPrompt || project.topic
    );
    const language = req.body.language?.trim() || project.language;
    const tone = req.body.tone?.trim() || project.tone;
    const resolvedTopic = await resolveTopicFromInput({
      topicPrompt,
      language,
      tone,
      fallbackTopic: project.topic
    });

    updateProject(project.id, {
      topic: resolvedTopic,
      language,
      tone,
      format: req.body.format?.trim() || project.format,
      channel_id: req.body.channelId?.trim() || null,
      scheduled_at: req.body.scheduledAt?.trim() || null,
      updated_at: new Date().toISOString(),
      settings_json: JSON.stringify({
        ...(project.settings ?? {}),
        topicPrompt,
        customPrompt: req.body.customPrompt?.trim() || "",
        durationMinutes
      })
    });

    res.redirect(`/projects/${project.id}/topic?notice=topic-saved`);
  });

  app.post("/projects/:id/bootstrap", async (req, res) => {
    const project = getProject(req.params.id);
    if (!project) {
      res.status(404).send("프로젝트를 찾을 수 없습니다.");
      return;
    }

    try {
      const hydrated = await hydrateProjectTopic(project);
      const durationMinutes = hydrated.settings?.durationMinutes || 10;
      const research = await fetchTrendIdeas({
        topicPrompt: hydrated.settings?.topicPrompt || hydrated.topic,
        topic: hydrated.topic,
        language: hydrated.language
      });
      const script = await generateScript({
        topic: hydrated.topic,
        tone: hydrated.tone,
        language: hydrated.language,
        research,
        customPrompt: hydrated.settings?.customPrompt || "",
        durationMinutes
      });

      updateProject(project.id, {
        topic: research.selectedTopic || hydrated.topic,
        updated_at: new Date().toISOString(),
        research_json: JSON.stringify(research),
        script_text: script
      });

      res.redirect(`/projects/${project.id}/script?notice=bootstrap-complete`);
    } catch (error) {
      res.status(500).send(error instanceof Error ? error.message : "자동 초안 생성에 실패했습니다.");
    }
  });

  app.post("/projects/:id/research/auto", async (req, res) => {
    const project = getProject(req.params.id);
    if (!project) {
      res.status(404).send("프로젝트를 찾을 수 없습니다.");
      return;
    }

    try {
      const hydrated = await hydrateProjectTopic(project);
      const research = await fetchTrendIdeas({
        topicPrompt: hydrated.settings?.topicPrompt || hydrated.topic,
        topic: hydrated.topic,
        language: hydrated.language
      });

      updateProject(project.id, {
        topic: research.selectedTopic || hydrated.topic,
        updated_at: new Date().toISOString(),
        research_json: JSON.stringify({
          ...research,
          manualNotes: hydrated.research?.manualNotes || ""
        })
      });

      res.redirect(`/projects/${project.id}/research?notice=research-auto`);
    } catch (error) {
      res.status(500).send(error instanceof Error ? error.message : "리서치 자동 수집에 실패했습니다.");
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
      selectedTopic: project.topic,
      summary: req.body.summary?.trim() || "",
      ideas: splitLines(req.body.ideas),
      manualNotes: req.body.manualNotes?.trim() || ""
    };

    updateProject(project.id, {
      updated_at: new Date().toISOString(),
      research_json: JSON.stringify(manualResearch)
    });

    res.redirect(`/projects/${project.id}/research?notice=research-saved`);
  });

  app.post("/projects/:id/script/auto", async (req, res) => {
    const project = getProject(req.params.id);
    if (!project) {
      res.status(404).send("프로젝트를 찾을 수 없습니다.");
      return;
    }

    try {
      const hydrated = await hydrateProjectTopic(project);
      const durationMinutes = hydrated.settings?.durationMinutes || 10;
      const research = hydrated.research ?? await fetchTrendIdeas({
        topicPrompt: hydrated.settings?.topicPrompt || hydrated.topic,
        topic: hydrated.topic,
        language: hydrated.language
      });
      const script = await generateScript({
        topic: hydrated.topic,
        tone: hydrated.tone,
        language: hydrated.language,
        research,
        customPrompt: hydrated.settings?.customPrompt || "",
        durationMinutes
      });

      updateProject(project.id, {
        topic: research.selectedTopic || hydrated.topic,
        updated_at: new Date().toISOString(),
        research_json: JSON.stringify(research),
        script_text: script
      });

      res.redirect(`/projects/${project.id}/script?notice=script-auto`);
    } catch (error) {
      res.status(500).send(error instanceof Error ? error.message : "대본 자동 생성에 실패했습니다.");
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

    res.redirect(`/projects/${project.id}/script?notice=script-saved`);
  });

  app.post("/projects/:id/run", async (req, res) => {
    try {
      await runProject(req.params.id);
      res.redirect(`/projects/${req.params.id}/render?notice=render-complete`);
    } catch (error) {
      res.status(500).send(error instanceof Error ? error.message : "렌더 실행에 실패했습니다.");
    }
  });

  app.post("/projects/:id/scenes/:sceneIndex/regenerate", async (req, res) => {
    try {
      await runProject(req.params.id, {
        regenerateSceneIndex: Number(req.params.sceneIndex)
      });
      res.redirect(`/projects/${req.params.id}/scenes?notice=scene-regenerated`);
    } catch (error) {
      res.status(500).send(error instanceof Error ? error.message : "장면 재생성에 실패했습니다.");
    }
  });

  app.post("/projects/:id/help", (req, res) => {
    try {
      const answer = askProjectHelp(req.params.id, req.body.question || "");
      renderProjectPage(res, req.params.id, "publish", answer);
    } catch (error) {
      res.status(500).send(error instanceof Error ? error.message : "도움말 생성에 실패했습니다.");
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
        "Google Vids 직접 생성 API는 아직 연결하지 않았습니다.",
        "현재 구조는 mp4, 자막, 장면 이미지를 묶어 Drive 또는 Vids 후속 작업에 넘기기 쉽게 구성되어 있습니다.",
        "Slides를 먼저 만든 뒤 Google Vids로 넘기는 방식도 검토할 수 있습니다."
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

function renderHomePage(res, requestedSection) {
  const activeHomeSection = normalizeHomeSection(requestedSection);
  const channels = listChannels();
  const projects = listProjects();

  res.render("index", {
    channels,
    projects,
    versionLabel,
    activeHomeSection,
    durationOptions,
    homeNav: homeSections.map((section) => ({
      key: section,
      href: `/workspace/${section}`,
      label: homeSectionLabel(section),
      shortLabel: homeSectionShortLabel(section),
      active: activeHomeSection === section
    }))
  });
}

function renderProjectPage(res, projectId, requestedStep, helpAnswer, noticeKey) {
  const project = getProject(projectId);
  if (!project) {
    res.status(404).send("프로젝트를 찾을 수 없습니다.");
    return;
  }

  const activeStep = normalizeStep(requestedStep);
  const steps = buildWorkflowSteps(project, activeStep);
  const topicPromptText = project.settings?.topicPrompt || project.topic || "";

  res.render("project", {
    project,
    activeStep,
    steps,
    channels: listChannels(),
    versionLabel,
    helpAnswer,
    durationOptions,
    noticeMessage: getNoticeMessage(noticeKey),
    topicPromptText,
    researchIdeasText: (project.research?.ideas ?? []).join("\n"),
    researchSummaryText: project.research?.summary ?? "",
    researchNotesText: project.research?.manualNotes ?? "",
    googleVidsNotes: [
      "공식 문서 기준으로 Google Vids는 Drive 자산과 mp4 기반 작업 흐름이 가장 안정적입니다.",
      "현재는 결과물 묶음을 JSON으로 열어 후속 작업에 넘길 수 있게 맞춰 두었습니다.",
      "이 프로젝트의 mp4, 자막, 장면 이미지를 한 번에 확인할 수 있습니다."
    ],
    githubStatus: {
      localGitReady: true,
      remoteConnected: true,
      note: "현재 GitHub 원격 저장소가 연결되어 있습니다."
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
    href: `/projects/${project.id}/${step}`,
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
    render: "5. 렌더 결과",
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

function normalizeHomeSection(section) {
  return homeSections.includes(section) ? section : "dashboard";
}

function homeSectionLabel(section) {
  const labels = {
    dashboard: "Studio 대시보드",
    create: "제작 시작",
    channels: "업로드 채널",
    projects: "프로젝트 보관함"
  };

  return labels[section];
}

function homeSectionShortLabel(section) {
  const labels = {
    dashboard: "Dashboard",
    create: "Create",
    channels: "Channels",
    projects: "Library"
  };

  return labels[section];
}

function normalizeTopicPrompt(value) {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .trim();
}

async function resolveTopicFromInput({ topicPrompt, language, tone, fallbackTopic }) {
  const prompt = normalizeTopicPrompt(topicPrompt);
  if (!prompt) {
    return fallbackTopic?.trim() || "주제 미정";
  }

  const resolvedTopic = await deriveTopicFromPrompt({
    topicPrompt: prompt,
    language,
    tone,
    fallbackTopic
  });

  return resolvedTopic?.trim() || fallbackTopic?.trim() || "주제 미정";
}

async function hydrateProjectTopic(project) {
  const topicPrompt = project.settings?.topicPrompt || project.topic || "";
  const needsResolution = !project.topic || isInstructionLikeTopic(project.topic) || isWeakResolvedTopic(project.topic);

  if (!needsResolution && project.settings?.topicPrompt) {
    return project;
  }

  const resolvedTopic = await resolveTopicFromInput({
    topicPrompt,
    language: project.language,
    tone: project.tone,
    fallbackTopic: project.topic
  });

  const nextSettings = {
    ...(project.settings ?? {}),
    topicPrompt
  };

  updateProject(project.id, {
    topic: resolvedTopic,
    updated_at: new Date().toISOString(),
    settings_json: JSON.stringify(nextSettings)
  });

  return getProject(project.id);
}

async function hydrateProjectById(projectId) {
  const project = getProject(projectId);
  if (!project) {
    return null;
  }

  return hydrateProjectTopic(project);
}

function parseDurationMinutes(value, fallback = 10) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return durationOptions.includes(parsed) ? parsed : fallback;
}

function getNoticeMessage(noticeKey) {
  const messages = {
    "project-created": "프로젝트가 생성되었습니다. 먼저 주제 프롬프트와 영상 길이를 확인해 주세요.",
    "topic-saved": "주제 프롬프트를 반영해 도출된 주제를 저장했습니다.",
    "research-auto": "프롬프트를 반영한 리서치 결과를 자동 수집했습니다.",
    "research-saved": "리서치 내용을 저장했습니다.",
    "script-auto": "영상 길이에 맞춘 대본 초안을 생성했습니다.",
    "script-saved": "대본을 저장했습니다.",
    "bootstrap-complete": "주제부터 대본까지 자동 생성이 완료되었습니다.",
    "render-complete": "렌더 실행이 완료되었습니다.",
    "scene-regenerated": "선택한 장면을 다시 생성했습니다."
  };

  return messages[noticeKey] || null;
}

function splitLines(value) {
  return String(value ?? "")
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
