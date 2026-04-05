import fs from "node:fs";
import path from "node:path";
import { getProject, projectsRoot, updateProject } from "./db.js";
import {
  answerHelpQuestion,
  buildStyleProfile,
  fetchTrendIdeas,
  generateScript,
  planScenes
} from "./services/content.js";
import {
  buildThumbnail,
  generateNarration,
  generateSceneImage,
  generateSrt,
  renderVideo
} from "./services/media.js";

function nowIso() {
  return new Date().toISOString();
}

export async function runProject(projectId, options = {}) {
  const project = getProject(projectId);
  if (!project) {
    throw new Error("프로젝트를 찾을 수 없습니다.");
  }

  updateProject(projectId, {
    status: "running",
    updated_at: nowIso()
  });

  try {
    const projectDir = path.join(projectsRoot, projectId);
    const scenesDir = path.join(projectDir, "scenes");
    const audioDir = path.join(projectDir, "audio");
    const videoDir = path.join(projectDir, "video");

    fs.mkdirSync(scenesDir, { recursive: true });
    fs.mkdirSync(audioDir, { recursive: true });
    fs.mkdirSync(videoDir, { recursive: true });

    const research = project.research ?? await fetchTrendIdeas(project.topic, project.language);
    const styleProfile = project.styleProfile ?? await buildStyleProfile(project.style_reference_path, project.format);
    const script = project.script_text ?? await generateScript({
      topic: project.topic,
      tone: project.tone,
      language: project.language,
      research,
      customPrompt: project.settings.customPrompt
    });

    const baseScenes = project.scenes.length
      ? project.scenes
      : planScenes({
          script,
          topic: project.topic,
          tone: project.tone,
          format: project.format,
          styleProfile,
          customPrompt: project.settings.customPrompt
        });

    const scenes = [...baseScenes];
    const regenerateSceneIndex = Number.isInteger(options.regenerateSceneIndex) ? options.regenerateSceneIndex : null;

    for (let index = 0; index < scenes.length; index += 1) {
      if (regenerateSceneIndex !== null && regenerateSceneIndex !== index && scenes[index].imagePath) {
        continue;
      }

      const imagePath = path.join(scenesDir, `scene-${String(index + 1).padStart(2, "0")}.png`);
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
      title: project.topic,
      outputPath: thumbnailPath,
      format: project.format
    });

    const output = {
      narrationPath,
      subtitlesPath,
      videoPath,
      thumbnailPath,
      uploadStatus: project.channel_id ? "queued" : "pending"
    };

    updateProject(projectId, {
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
    updateProject(projectId, {
      status: "failed",
      updated_at: nowIso(),
      output_json: JSON.stringify({
        ...(project.output ?? {}),
        error: error instanceof Error ? error.message : "알 수 없는 오류"
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
