import fs from "node:fs";
import path from "node:path";
import { getProject, projectsRoot, updateProject } from "./db.js";
import {
  answerHelpQuestion,
  buildStyleProfile,
  deriveTopicFromPrompt,
  fetchTrendIdeas,
  generateScript,
  isInstructionLikeTopic,
  isWeakResolvedTopic,
  planScenes
} from "./services/content.js";
import {
  buildThumbnail,
  generateNarration,
  generateSceneImage,
  generateSrt,
  renderVideo
} from "./services/media.js";

const generationStepOrder = ["topic", "research", "script", "scenes", "render", "publish"];
const generationControllers = new Map();

class GenerationResetError extends Error {
  constructor() {
    super("generation-reset-requested");
  }
}

function nowIso() {
  return new Date().toISOString();
}

function generationStepLabel(step) {
  const labels = {
    topic: "주제 설정",
    research: "소재 발굴",
    script: "대본 작성",
    scenes: "장면 생성",
    render: "렌더 결과",
    publish: "업로드"
  };

  return labels[step] || "자동 생성";
}

function createDefaultGenerationSteps() {
  return {
    topic: { state: "pending", detail: "대기" },
    research: { state: "pending", detail: "대기" },
    script: { state: "pending", detail: "대기" },
    scenes: { state: "pending", detail: "대기" },
    render: { state: "pending", detail: "대기" },
    publish: { state: "pending", detail: "대기" }
  };
}

function createDefaultGenerationState(project) {
  return {
    mode: "auto",
    state: "idle",
    currentStep: "topic",
    currentLabel: generationStepLabel("topic"),
    percent: 0,
    detail: "자동 생성 대기",
    sceneCurrent: 0,
    sceneTotal: project?.scenes?.length || 0,
    error: null,
    updatedAt: nowIso(),
    steps: createDefaultGenerationSteps()
  };
}

function getUploadStatusForProject(project) {
  return project.channel_id ? "queued" : "pending";
}

function mergeGenerationSteps(previousSteps, nextSteps) {
  const merged = { ...createDefaultGenerationSteps() };

  generationStepOrder.forEach((step) => {
    merged[step] = {
      ...(previousSteps?.[step] ?? createDefaultGenerationSteps()[step]),
      ...(nextSteps?.[step] ?? {})
    };
  });

  return merged;
}

function persistGeneration(projectId, generationPatch = {}, outputPatch = {}) {
  const latest = getProject(projectId);
  if (!latest) {
    return null;
  }

  const previousGeneration = latest.output?.generation ?? createDefaultGenerationState(latest);
  const nextGeneration = {
    ...previousGeneration,
    ...generationPatch,
    error: generationPatch.error === undefined ? (previousGeneration.error ?? null) : generationPatch.error,
    updatedAt: nowIso(),
    steps: mergeGenerationSteps(previousGeneration.steps, generationPatch.steps)
  };

  const nextOutput = {
    ...(latest.output ?? {}),
    ...outputPatch,
    generation: nextGeneration
  };

  updateProject(projectId, {
    updated_at: nowIso(),
    output_json: JSON.stringify(nextOutput)
  });

  return getProject(projectId);
}

function countGeneratedSceneImages(scenes) {
  return (scenes ?? []).filter((scene) => scene.imagePath && fs.existsSync(scene.imagePath)).length;
}

function buildCompletionStepPatch(project) {
  const patch = {};

  if (project.topic) {
    patch.topic = { state: "done", detail: "주제 준비됨" };
  }

  if (project.research?.ideas?.length || project.research?.summary) {
    patch.research = { state: "done", detail: "리서치 저장됨" };
  }

  if (project.script_text) {
    patch.script = { state: "done", detail: "대본 저장됨" };
  }

  if (Array.isArray(project.scenes) && project.scenes.length > 0 && countGeneratedSceneImages(project.scenes) === project.scenes.length) {
    patch.scenes = { state: "done", detail: "장면 이미지 준비됨" };
  }

  if (project.output?.videoPath && fs.existsSync(project.output.videoPath)) {
    patch.render = { state: "done", detail: "렌더 완료" };
  }

  if (project.output?.uploadStatus === "uploaded") {
    patch.publish = { state: "done", detail: "업로드 완료" };
  } else if (project.output?.uploadStatus === "queued") {
    patch.publish = { state: "pending", detail: "업로드 대기" };
  }

  return patch;
}

function setGenerationStep(projectId, step, state, detail, percent, extras = {}) {
  return persistGeneration(projectId, {
    state: extras.globalState,
    currentStep: step,
    currentLabel: generationStepLabel(step),
    percent,
    detail,
    sceneCurrent: extras.sceneCurrent,
    sceneTotal: extras.sceneTotal,
    error: extras.error,
    steps: {
      [step]: { state, detail }
    }
  }, extras.outputPatch);
}

async function waitForResumeIfNeeded(projectId, controller, step, detail, extras = {}) {
  if (!controller) {
    return;
  }

  if (controller.resetRequested) {
    throw new GenerationResetError();
  }

  if (!controller.pauseRequested) {
    return;
  }

  controller.paused = true;
  persistGeneration(projectId, {
    state: "paused",
    currentStep: step,
    currentLabel: generationStepLabel(step),
    percent: extras.percent,
    detail: "일시중지됨",
    sceneCurrent: extras.sceneCurrent,
    sceneTotal: extras.sceneTotal,
    steps: {
      [step]: { state: "paused", detail: "일시중지됨" }
    }
  });

  await new Promise((resolve) => {
    controller.resumeResolver = resolve;
  });

  controller.resumeResolver = null;
  controller.paused = false;

  if (controller.resetRequested) {
    throw new GenerationResetError();
  }

  persistGeneration(projectId, {
    state: "running",
    currentStep: step,
    currentLabel: generationStepLabel(step),
    percent: extras.percent,
    detail,
    sceneCurrent: extras.sceneCurrent,
    sceneTotal: extras.sceneTotal,
    steps: {
      [step]: { state: "running", detail }
    }
  });
}

async function hydrateRuntimeProject(project) {
  const topicPrompt = project.settings?.topicPrompt || project.topic || "";

  if (project.topic && !isInstructionLikeTopic(project.topic) && !isWeakResolvedTopic(project.topic) && project.settings?.topicPrompt) {
    return project;
  }

  const topic = await deriveTopicFromPrompt({
    topicPrompt,
    language: project.language,
    fallbackTopic: project.topic
  });

  updateProject(project.id, {
    topic,
    updated_at: nowIso(),
    settings_json: JSON.stringify({
      ...(project.settings ?? {}),
      topicPrompt
    })
  });

  return getProject(project.id);
}

function ensureProjectDirectories(projectId) {
  const projectDir = path.join(projectsRoot, projectId);
  const scenesDir = path.join(projectDir, "scenes");
  const audioDir = path.join(projectDir, "audio");
  const videoDir = path.join(projectDir, "video");

  fs.mkdirSync(scenesDir, { recursive: true });
  fs.mkdirSync(audioDir, { recursive: true });
  fs.mkdirSync(videoDir, { recursive: true });

  return { projectDir, scenesDir, audioDir, videoDir };
}

function clearProjectArtifacts(projectId) {
  const projectDir = path.join(projectsRoot, projectId);
  fs.rmSync(projectDir, { recursive: true, force: true });
}

export function startProjectAutomation(projectId, options = {}) {
  const existing = generationControllers.get(projectId);
  if (existing) {
    return { started: false };
  }

  const controller = {
    pauseRequested: false,
    paused: false,
    resetRequested: false,
    resumeResolver: null
  };

  generationControllers.set(projectId, controller);
  controller.promise = runProject(projectId, {
    automation: true,
    controller,
    resume: options.resume === true
  })
    .catch(() => undefined)
    .finally(() => {
      if (generationControllers.get(projectId) === controller) {
        generationControllers.delete(projectId);
      }
    });

  return { started: true };
}

export function pauseProjectAutomation(projectId) {
  const controller = generationControllers.get(projectId);
  if (!controller) {
    return { ok: false };
  }

  controller.pauseRequested = true;
  persistGeneration(projectId, {
    state: "pause_requested",
    detail: "현재 단계 완료 후 일시중지합니다."
  });

  return { ok: true };
}

export function resumeProjectAutomation(projectId) {
  const controller = generationControllers.get(projectId);
  if (controller) {
    controller.pauseRequested = false;
    if (controller.resumeResolver) {
      controller.resumeResolver();
    }
    return { resumed: true, restarted: false };
  }

  const project = getProject(projectId);
  if (project?.output?.generation?.state === "paused") {
    startProjectAutomation(projectId, { resume: true });
    return { resumed: true, restarted: true };
  }

  return { resumed: false, restarted: false };
}

function performProjectReset(projectId) {
  const project = getProject(projectId);
  if (!project) {
    return null;
  }

  clearProjectArtifacts(projectId);

  updateProject(projectId, {
    status: "draft",
    updated_at: nowIso(),
    research_json: null,
    style_json: null,
    script_text: null,
    scenes_json: JSON.stringify([]),
    output_json: JSON.stringify({
      uploadStatus: getUploadStatusForProject(project),
      generation: {
        ...createDefaultGenerationState({ ...project, scenes: [] }),
        detail: "초기화됨"
      }
    })
  });

  return getProject(projectId);
}

export function resetProjectAutomation(projectId) {
  const controller = generationControllers.get(projectId);
  if (!controller) {
    performProjectReset(projectId);
    return { scheduled: false };
  }

  controller.resetRequested = true;
  controller.pauseRequested = false;
  if (controller.resumeResolver) {
    controller.resumeResolver();
  }

  persistGeneration(projectId, {
    state: "running",
    detail: "초기화 처리 중입니다."
  });

  return { scheduled: true };
}

export async function runProject(projectId, options = {}) {
  const initialProject = getProject(projectId);
  if (!initialProject) {
    throw new Error("프로젝트를 찾을 수 없습니다.");
  }

  const controller = options.controller;
  const automation = options.automation === true;

  updateProject(projectId, {
    status: "running",
    updated_at: nowIso()
  });

  if (automation) {
    persistGeneration(projectId, {
      ...createDefaultGenerationState(initialProject),
      state: "running",
      detail: options.resume ? "자동 생성을 재개합니다." : "자동 생성을 시작합니다.",
      steps: buildCompletionStepPatch(initialProject),
      sceneCurrent: countGeneratedSceneImages(initialProject.scenes),
      sceneTotal: initialProject.scenes.length
    });
  }

  try {
    let project = await hydrateRuntimeProject(getProject(projectId));
    const { scenesDir, audioDir, videoDir } = ensureProjectDirectories(projectId);
    const regenerateSceneIndex = Number.isInteger(options.regenerateSceneIndex) ? options.regenerateSceneIndex : null;

    if (automation) {
      setGenerationStep(projectId, "topic", "running", "주제를 정리하는 중입니다.", 8);
    }

    project = getProject(projectId);
    if (automation) {
      setGenerationStep(projectId, "topic", "done", "주제 설정 완료", 14);
      await waitForResumeIfNeeded(projectId, controller, "topic", "주제 설정 완료", { percent: 14 });
      setGenerationStep(projectId, "research", "running", "리서치를 수집하는 중입니다.", 22);
    }

    const research = project.research ?? await fetchTrendIdeas({
      topicPrompt: project.settings?.topicPrompt || project.topic,
      topic: project.topic,
      language: project.language
    });

    updateProject(projectId, {
      topic: research.selectedTopic || project.topic,
      updated_at: nowIso(),
      research_json: JSON.stringify({
        ...research,
        manualNotes: project.research?.manualNotes || research.manualNotes || ""
      })
    });

    project = getProject(projectId);
    if (automation) {
      setGenerationStep(projectId, "research", "done", "리서치 저장 완료", 28);
      await waitForResumeIfNeeded(projectId, controller, "research", "리서치 저장 완료", { percent: 28 });
      setGenerationStep(projectId, "script", "running", "대본을 생성하는 중입니다.", 36);
    }

    const styleProfile = project.styleProfile ?? await buildStyleProfile(project.style_reference_path, project.format);
    const script = project.script_text ?? await generateScript({
      topic: research.selectedTopic || project.topic,
      tone: project.tone,
      language: project.language,
      research,
      customPrompt: project.settings?.customPrompt || "",
      durationMinutes: project.settings?.durationMinutes || 10
    });

    updateProject(projectId, {
      updated_at: nowIso(),
      style_json: JSON.stringify(styleProfile),
      script_text: script
    });

    project = getProject(projectId);
    if (automation) {
      setGenerationStep(projectId, "script", "done", "대본 생성 완료", 46);
      await waitForResumeIfNeeded(projectId, controller, "script", "대본 생성 완료", { percent: 46 });
      setGenerationStep(projectId, "scenes", "running", "장면을 준비하는 중입니다.", 52, {
        sceneCurrent: countGeneratedSceneImages(project.scenes),
        sceneTotal: project.scenes.length
      });
    }

    const baseScenes = project.scenes.length
      ? project.scenes
      : planScenes({
          script,
          topic: research.selectedTopic || project.topic,
          tone: project.tone,
          format: project.format,
          styleProfile,
          customPrompt: project.settings?.customPrompt || ""
        });

    const scenes = [...baseScenes];
    const sceneTotal = scenes.length;

    updateProject(projectId, {
      updated_at: nowIso(),
      scenes_json: JSON.stringify(scenes)
    });

    for (let index = 0; index < scenes.length; index += 1) {
      if (controller?.resetRequested) {
        throw new GenerationResetError();
      }

      if (regenerateSceneIndex !== null && regenerateSceneIndex !== index && scenes[index].imagePath) {
        continue;
      }

      const imagePath = path.join(scenesDir, `scene-${String(index + 1).padStart(2, "0")}.png`);
      if (regenerateSceneIndex === null && scenes[index].imagePath && fs.existsSync(scenes[index].imagePath)) {
        if (automation) {
          const percent = 52 + Math.round(((index + 1) / Math.max(sceneTotal, 1)) * 18);
          setGenerationStep(projectId, "scenes", "running", `장면 ${index + 1}/${sceneTotal} 확인 완료`, percent, {
            sceneCurrent: index + 1,
            sceneTotal
          });
          await waitForResumeIfNeeded(projectId, controller, "scenes", `장면 ${index + 1}/${sceneTotal} 확인 완료`, {
            percent,
            sceneCurrent: index + 1,
            sceneTotal
          });
        }
        continue;
      }

      await generateSceneImage({
        outputPath: imagePath,
        scene: scenes[index],
        styleProfile,
        format: project.format
      });

      scenes[index] = {
        ...scenes[index],
        imagePath
      };

      updateProject(projectId, {
        updated_at: nowIso(),
        scenes_json: JSON.stringify(scenes)
      });

      if (automation) {
        const percent = 52 + Math.round(((index + 1) / Math.max(sceneTotal, 1)) * 18);
        setGenerationStep(projectId, "scenes", "running", `장면 ${index + 1}/${sceneTotal} 생성 중`, percent, {
          sceneCurrent: index + 1,
          sceneTotal
        });
        await waitForResumeIfNeeded(projectId, controller, "scenes", `장면 ${index + 1}/${sceneTotal} 생성 중`, {
          percent,
          sceneCurrent: index + 1,
          sceneTotal
        });
      }
    }

    if (automation) {
      setGenerationStep(projectId, "scenes", "done", "장면 생성 완료", 72, {
        sceneCurrent: sceneTotal,
        sceneTotal
      });
      await waitForResumeIfNeeded(projectId, controller, "scenes", "장면 생성 완료", {
        percent: 72,
        sceneCurrent: sceneTotal,
        sceneTotal
      });
      setGenerationStep(projectId, "render", "running", "음성, 자막, 영상을 렌더하는 중입니다.", 78);
    }

    const narrationPath = path.join(audioDir, "narration.mp3");
    const subtitlesPath = path.join(videoDir, "captions.srt");
    const videoPath = path.join(videoDir, "final.mp4");
    const thumbnailPath = path.join(videoDir, "thumbnail.jpg");

    await generateNarration({
      script,
      language: project.language,
      outputPath: narrationPath
    });

    generateSrt({ scenes, outputPath: subtitlesPath });

    await renderVideo({
      sceneImages: scenes.map((scene) => scene.imagePath),
      scenes,
      outputPath: videoPath,
      subtitlesPath,
      narrationPath,
      bgmPath: project.bgm_path,
      watermarkPath: project.watermark_path,
      format: project.format
    });

    await buildThumbnail({
      imagePath: scenes[0].imagePath,
      title: research.selectedTopic || project.topic,
      outputPath: thumbnailPath,
      format: project.format
    });

    const latestOutput = getProject(projectId)?.output ?? {};
    const output = {
      ...latestOutput,
      narrationPath,
      subtitlesPath,
      videoPath,
      thumbnailPath,
      uploadStatus: getUploadStatusForProject(project)
    };

    if (automation) {
      output.generation = {
        ...(latestOutput.generation ?? createDefaultGenerationState(project)),
        state: "completed",
        currentStep: "render",
        currentLabel: generationStepLabel("render"),
        percent: 100,
        detail: "자동 생성 완료",
        sceneCurrent: sceneTotal,
        sceneTotal,
        error: null,
        updatedAt: nowIso(),
        steps: mergeGenerationSteps(latestOutput.generation?.steps, {
          topic: { state: "done", detail: "주제 설정 완료" },
          research: { state: "done", detail: "리서치 저장 완료" },
          script: { state: "done", detail: "대본 생성 완료" },
          scenes: { state: "done", detail: "장면 생성 완료" },
          render: { state: "done", detail: "렌더 완료" },
          publish: {
            state: output.uploadStatus === "uploaded" ? "done" : "pending",
            detail: output.uploadStatus === "queued" ? "업로드 대기" : "채널 연결 대기"
          }
        })
      };
    }

    updateProject(projectId, {
      topic: research.selectedTopic || project.topic,
      status: "ready",
      updated_at: nowIso(),
      research_json: JSON.stringify(research),
      style_json: JSON.stringify(styleProfile),
      script_text: script,
      scenes_json: JSON.stringify(scenes),
      output_json: JSON.stringify(output)
    });

    return getProject(projectId);
  } catch (error) {
    if (error instanceof GenerationResetError) {
      performProjectReset(projectId);
      return getProject(projectId);
    }

    const latest = getProject(projectId) ?? initialProject;
    const latestOutput = latest.output ?? {};
    const generation = latestOutput.generation
      ? {
          ...latestOutput.generation,
          state: "failed",
          error: error instanceof Error ? error.message : "알 수 없는 오류",
          detail: "자동 생성 실패",
          updatedAt: nowIso()
        }
      : undefined;

    updateProject(projectId, {
      status: "failed",
      updated_at: nowIso(),
      output_json: JSON.stringify({
        ...latestOutput,
        error: error instanceof Error ? error.message : "알 수 없는 오류",
        ...(generation ? { generation } : {})
      })
    });
    throw error;
  }
}

export function askProjectHelp(projectId, question) {
  const project = getProject(projectId);
  if (!project) {
    throw new Error("프로젝트를 찾을 수 없습니다.");
  }

  return answerHelpQuestion(project, question);
}
