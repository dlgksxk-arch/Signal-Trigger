import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import sharp from "sharp";
import ffmpegPath from "ffmpeg-static";

function ensureDir(target) {
  fs.mkdirSync(target, { recursive: true });
}

function toPosix(filePath) {
  return path.resolve(filePath).replace(/\\/g, "/");
}

function escapeFilterPath(filePath) {
  return toPosix(filePath).replace(/:/g, "\\:").replace(/'/g, "\\'");
}

function hashSeed(input) {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash << 5) - hash) + input.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function getImageGenerationConfig(format) {
  return {
    width: format === "landscape" ? 1920 : 1080,
    height: format === "landscape" ? 1080 : 1920,
    openAiSize: format === "landscape" ? "1536x1024" : "1024x1536"
  };
}

async function generateWithOpenAI({ outputPath, scene, format }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return false;
  }

  const imageBaseUrl = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const imageModel = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1";
  const imageQuality = process.env.OPENAI_IMAGE_QUALITY || "medium";
  const { width, height, openAiSize } = getImageGenerationConfig(format);

  const response = await fetch(`${imageBaseUrl}/images/generations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: imageModel,
      prompt: scene.imagePrompt,
      size: openAiSize,
      quality: imageQuality,
      n: 1
    })
  });

  if (!response.ok) {
    return false;
  }

  const data = await response.json();
  const imageBase64 = data?.data?.[0]?.b64_json;
  if (!imageBase64) {
    return false;
  }

  const buffer = Buffer.from(imageBase64, "base64");
  await sharp(buffer).resize(width, height, { fit: "cover" }).png().toFile(outputPath);
  return true;
}

export async function generateSceneImage({ outputPath, scene, styleProfile, format }) {
  ensureDir(path.dirname(outputPath));

  const { width, height } = getImageGenerationConfig(format);
  const seed = hashSeed(scene.variationSeed);
  const useRemote = (process.env.ENABLE_POLLINATIONS_IMAGE || "true") === "true";

  try {
    const usedOpenAi = await generateWithOpenAI({ outputPath, scene, format });
    if (usedOpenAi) {
      return outputPath;
    }
  } catch {
    // fallback below
  }

  if (useRemote) {
    try {
      const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(scene.imagePrompt)}?width=${width}&height=${height}&seed=${seed}&model=flux&nologo=true`;
      const response = await fetch(url);
      if (response.ok) {
        const buffer = Buffer.from(await response.arrayBuffer());
        await sharp(buffer).resize(width, height, { fit: "cover" }).png().toFile(outputPath);
        return outputPath;
      }
    } catch {
      // fallback below
    }
  }

  const background = styleProfile?.palette?.[0] || "#111827";
  const accent = styleProfile?.palette?.[1] || "#2563eb";
  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="${background}" />
          <stop offset="100%" stop-color="${accent}" />
        </linearGradient>
      </defs>
      <rect width="100%" height="100%" fill="url(#bg)" />
      <rect x="48" y="48" width="${width - 96}" height="${height - 96}" rx="28" fill="rgba(0,0,0,0.18)" stroke="rgba(255,255,255,0.18)" />
      <text x="72" y="${Math.round(height * 0.18)}" font-size="${format === "landscape" ? 72 : 64}" fill="#ffffff" font-family="Arial" font-weight="700">${escapeXml(scene.title)}</text>
      <text x="72" y="${Math.round(height * 0.28)}" font-size="${format === "landscape" ? 32 : 28}" fill="#e5e7eb" font-family="Arial">${escapeXml(scene.imagePrompt.slice(0, 120))}</text>
    </svg>
  `;

  await sharp(Buffer.from(svg)).png().toFile(outputPath);
  return outputPath;
}

export async function generateNarration({ script, language, outputPath, subtitlesPath }) {
  ensureDir(path.dirname(outputPath));
  const textPath = path.join(path.dirname(outputPath), "narration.txt");
  fs.writeFileSync(textPath, script, "utf8");
  const voice = pickVoice(language);
  const voiceOptions = pickVoiceOptions(language);

  const args = [
    "-m",
    "edge_tts",
    "--file",
    textPath,
    "--voice",
    voice,
    `--rate=${voiceOptions.rate}`,
    `--pitch=${voiceOptions.pitch}`,
    "--write-media",
    outputPath
  ];

  if (subtitlesPath) {
    ensureDir(path.dirname(subtitlesPath));
    args.push("--write-subtitles", subtitlesPath);
  }

  await runCommand("py", args);
  return outputPath;
}

function pickVoice(language) {
  if (language === "en") {
    return process.env.DEFAULT_EN_VOICE || "en-US-AndrewMultilingualNeural";
  }

  if (language === "ja") {
    return process.env.DEFAULT_JA_VOICE || "ja-JP-KeitaNeural";
  }

  return process.env.DEFAULT_KO_VOICE || "ko-KR-InJoonNeural";
}

function pickVoiceOptions(language) {
  if (language === "en") {
    return { rate: "+4%", pitch: "-8Hz" };
  }

  if (language === "ja") {
    return { rate: "+2%", pitch: "-6Hz" };
  }

  return { rate: "+3%", pitch: "-8Hz" };
}

export function generateSrt({ scenes, outputPath }) {
  ensureDir(path.dirname(outputPath));
  let cursor = 0;
  const lines = [];

  scenes.forEach((scene, index) => {
    const duration = scene.durationSec ?? estimateDuration(scene.narration);
    lines.push(String(index + 1));
    lines.push(`${secondsToSrt(cursor)} --> ${secondsToSrt(cursor + duration)}`);
    lines.push(scene.narration);
    lines.push("");
    cursor += duration;
  });

  fs.writeFileSync(outputPath, lines.join("\n"), "utf8");
  return outputPath;
}

function estimateDuration(text) {
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  return Math.max(6, Math.round((wordCount || Math.ceil(text.length / 6)) / 2.4));
}

function normalizeCopy(text) {
  return String(text ?? "")
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^Point\s+\d+\.\s*/i, "")
    .replace(/^[0-9]+\.\s*/, "")
    .replace(/^(First|Second|Third|Finally|Meanwhile|So)\s*,\s*/i, "")
    .replace(/^["'\s]+|["'\s]+$/g, "")
    .trim();
}

function compactHookCopy(text) {
  return normalizeCopy(text)
    .replace(/^(this video|in this video|today|이번 영상에서는|이번 영상은|오늘은)\s*/i, "")
    .replace(/^(we explain|we break down|we connect|지금부터|핵심은)\s*/i, "")
    .replace(/\b(because|and|that|which)\b.*$/i, "")
    .replace(/(입니다|됩니다|합니다)\.?$/g, "")
    .replace(/[,:;]+$/g, "")
    .trim();
}

function hookScore(text) {
  const value = normalizeCopy(text);
  if (!value) {
    return -1;
  }

  const keywords = [
    "war", "nuclear", "collapse", "secret", "power", "crisis", "invasion", "sanctions",
    "empire", "showdown", "regime", "trigger", "flashpoint", "conflict", "threat",
    "전쟁", "핵", "붕괴", "비밀", "충돌", "위기", "패권", "침공", "제재", "정권", "폭발"
  ];

  let score = 0;
  if (/[?!]/.test(value)) score += 4;
  if (/\d/.test(value)) score += 2;
  if (value.length >= 14 && value.length <= 54) score += 5;
  if (value.length > 54 && value.length <= 72) score += 2;
  score += keywords.reduce((total, keyword) => total + (value.toLowerCase().includes(keyword.toLowerCase()) ? 2 : 0), 0);
  return score;
}

function pickThumbnailText({ script, scenes, title }) {
  const sentenceCandidates = [];
  const sourceText = [script, ...(scenes ?? []).map((scene) => scene.narration)].join(" ");
  const parts = sourceText
    .split(/(?<=[.!?。！？])\s+|\n+/)
    .map((item) => compactHookCopy(item))
    .filter((item) => item.length >= 6)
    .filter((item) => item.length <= 42);

  sentenceCandidates.push(...parts);
  const best = sentenceCandidates
    .sort((left, right) => hookScore(right) - hookScore(left))[0];

  return best || compactHookCopy(title) || "WHAT CHANGES NEXT?";
}

function pickThumbnailImage({ imagePath, scenes }) {
  const scene = (scenes ?? [])
    .filter((item) => item.imagePath && fs.existsSync(item.imagePath))
    .sort((left, right) => hookScore(right.narration) - hookScore(left.narration))[0];

  return scene?.imagePath || imagePath;
}

function wrapThumbnailText(text, format) {
  const source = compactHookCopy(text);
  const maxChars = format === "landscape" ? 12 : 10;
  const maxLines = 2;
  const words = source.includes(" ") ? source.split(/\s+/) : source.split("");
  const lines = [];
  let current = "";

  words.forEach((word) => {
    const next = current ? `${current}${source.includes(" ") ? " " : ""}${word}` : word;
    if (next.length > maxChars && current) {
      lines.push(current);
      current = word;
      return;
    }
    current = next;
  });

  if (current) {
    lines.push(current);
  }

  return lines
    .slice(0, maxLines)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => /[a-z]/i.test(line) ? line.toUpperCase() : line);
}

function secondsToSrt(seconds) {
  const totalMs = Math.round(seconds * 1000);
  const hours = Math.floor(totalMs / 3_600_000).toString().padStart(2, "0");
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000).toString().padStart(2, "0");
  const secs = Math.floor((totalMs % 60_000) / 1000).toString().padStart(2, "0");
  const ms = Math.floor(totalMs % 1000).toString().padStart(3, "0");
  return `${hours}:${minutes}:${secs},${ms}`;
}

export async function buildThumbnail({ imagePath, title, outputPath, format, scenes = [], script = "" }) {
  ensureDir(path.dirname(outputPath));
  const width = format === "landscape" ? 1280 : 1080;
  const height = format === "landscape" ? 720 : 1920;
  const selectedImagePath = pickThumbnailImage({ imagePath, scenes });
  const hookText = pickThumbnailText({ script, scenes, title });
  const lines = wrapThumbnailText(hookText, format);
  const baseX = format === "landscape" ? 52 : 46;
  const baseY = format === "landscape" ? Math.round(height * 0.66) : Math.round(height * 0.7);
  const lineHeight = format === "landscape" ? 108 : 94;
  const fontSize = format === "landscape" ? 88 : 74;
  const fills = ["#ffffff", "#facc15"];
  const textSvg = lines.map((line, index) => {
    const y = baseY + (index * lineHeight);
    const fill = fills[index] || "#ffffff";
    return `<text x="${baseX}" y="${y}" font-size="${fontSize}" fill="${fill}" stroke="#0b0c0f" stroke-width="22" paint-order="stroke" font-family="Arial" font-weight="900" letter-spacing="-1">${escapeXml(line)}</text>`;
  }).join("");

  const overlay = Buffer.from(`
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="shade" x1="0%" y1="100%" x2="0%" y2="0%">
          <stop offset="0%" stop-color="rgba(0,0,0,0.84)" />
          <stop offset="55%" stop-color="rgba(0,0,0,0.36)" />
          <stop offset="100%" stop-color="rgba(0,0,0,0.04)" />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="${width}" height="${height}" fill="url(#shade)" />
      <rect x="${baseX - 20}" y="${baseY - fontSize}" width="${format === "landscape" ? width * 0.54 : width * 0.76}" height="${lineHeight * Math.max(lines.length, 1) + 28}" rx="26" fill="rgba(0,0,0,0.18)" />
      ${textSvg}
    </svg>
  `);

  await sharp(selectedImagePath)
    .resize(width, height, { fit: "cover" })
    .composite([{ input: overlay }])
    .jpeg({ quality: 90 })
    .toFile(outputPath);

  return outputPath;
}

function getAnimatedClipMotion(index) {
  const motions = [
    {
      zoom: "min(zoom+0.00045,1.14)",
      x: "iw/2-(iw/zoom/2)+sin(on/18)*28",
      y: "ih/2-(ih/zoom/2)+cos(on/24)*16"
    },
    {
      zoom: "min(zoom+0.00038,1.12)",
      x: "iw/2-(iw/zoom/2)-on*0.22",
      y: "ih/2-(ih/zoom/2)+sin(on/26)*20"
    },
    {
      zoom: "if(lte(on,45),1.08,max(1.01,zoom-0.00028))",
      x: "iw/2-(iw/zoom/2)+on*0.18",
      y: "ih/2-(ih/zoom/2)-cos(on/20)*18"
    }
  ];

  return motions[index % motions.length];
}

async function buildAnimatedSceneClip({ imagePath, durationSec, outputPath, format, index }) {
  ensureDir(path.dirname(outputPath));
  const width = format === "landscape" ? 1920 : 1080;
  const height = format === "landscape" ? 1080 : 1920;
  const sourceWidth = Math.round(width * 1.18);
  const sourceHeight = Math.round(height * 1.18);
  const fps = 30;
  const frameCount = Math.max(1, Math.round(durationSec * fps));
  const motion = getAnimatedClipMotion(index);

  await runFfmpeg([
    "-y",
    "-loop", "1",
    "-i", imagePath,
    "-vf",
    [
      `scale=${sourceWidth}:${sourceHeight}`,
      `zoompan=z='${motion.zoom}':x='${motion.x}':y='${motion.y}':d=${frameCount}:s=${width}x${height}:fps=${fps}`,
      "format=yuv420p"
    ].join(","),
    "-t", String(durationSec),
    "-r", String(fps),
    "-pix_fmt", "yuv420p",
    outputPath
  ]);

  return outputPath;
}

export async function renderVideo({
  sceneImages,
  scenes,
  outputPath,
  subtitlesPath,
  narrationPath,
  bgmPath,
  watermarkPath,
  format
}) {
  ensureDir(path.dirname(outputPath));
  const durations = scenes.map((scene) => scene.durationSec);
  const clipsDir = path.join(path.dirname(outputPath), "clips");
  ensureDir(clipsDir);

  const clipPaths = [];
  for (let index = 0; index < sceneImages.length; index += 1) {
    const clipPath = path.join(clipsDir, `scene-${String(index + 1).padStart(2, "0")}.mp4`);
    await buildAnimatedSceneClip({
      imagePath: sceneImages[index],
      durationSec: durations[index],
      outputPath: clipPath,
      format,
      index
    });
    clipPaths.push(clipPath);
  }

  const args = ["-y"];
  clipPaths.forEach((clipPath) => {
    args.push("-i", clipPath);
  });
  const inputIndices = { narration: null, bgm: null, watermark: null };
  let inputCount = clipPaths.length;

  if (narrationPath && fs.existsSync(narrationPath)) {
    args.push("-i", narrationPath);
    inputIndices.narration = inputCount;
    inputCount += 1;
  }

  if (bgmPath && fs.existsSync(bgmPath)) {
    args.push("-i", bgmPath);
    inputIndices.bgm = inputCount;
    inputCount += 1;
  }

  if (watermarkPath && fs.existsSync(watermarkPath)) {
    args.push("-i", watermarkPath);
    inputIndices.watermark = inputCount;
    inputCount += 1;
  }

  const width = format === "landscape" ? 1920 : 1080;
  const height = format === "landscape" ? 1080 : 1920;
  const filters = [];
  let currentVideo = "v0";

  if (clipPaths.length === 1) {
    filters.push(`[0:v]scale=${width}:${height},setsar=1[v0]`);
  } else {
    filters.push(`[0:v]scale=${width}:${height},setsar=1[v0]`);
    const transitions = ["fade", "smoothleft", "smoothright", "circleopen"];
    let offset = durations[0];

    for (let index = 1; index < clipPaths.length; index += 1) {
      const previousLabel = `v${index - 1}`;
      const nextLabel = `v${index}`;
      const transitionDuration = Math.min(0.45, Math.max(0.24, durations[index - 1] * 0.08));
      offset = Math.max(0, offset - transitionDuration);
      filters.push(`[${index}:v]scale=${width}:${height},setsar=1[s${index}]`);
      filters.push(`[${previousLabel}][s${index}]xfade=transition=${transitions[(index - 1) % transitions.length]}:duration=${transitionDuration}:offset=${offset}[${nextLabel}]`);
      offset += durations[index];
      currentVideo = nextLabel;
    }
  }

  if (inputIndices.watermark !== null) {
    filters.push(`[${inputIndices.watermark}:v]scale=220:-1[wm]`);
    filters.push(`[${currentVideo}][wm]overlay=W-w-32:H-h-32[v1]`);
    currentVideo = "v1";
  }

  if (subtitlesPath && fs.existsSync(subtitlesPath)) {
    filters.push(`[${currentVideo}]subtitles='${escapeFilterPath(subtitlesPath)}'[vout]`);
    currentVideo = "vout";
  }

  if (inputIndices.narration !== null && inputIndices.bgm !== null) {
    filters.push(`[${inputIndices.narration}:a]volume=1.0[na]`);
    filters.push(`[${inputIndices.bgm}:a]volume=0.15[ba]`);
    filters.push(`[na][ba]amix=inputs=2:duration=longest[aout]`);
  }

  args.push("-filter_complex", filters.join(";"));
  args.push("-map", `[${currentVideo}]`);

  if (inputIndices.narration !== null && inputIndices.bgm !== null) {
    args.push("-map", "[aout]");
  } else if (inputIndices.narration !== null) {
    args.push("-map", `${inputIndices.narration}:a`);
  } else if (inputIndices.bgm !== null) {
    args.push("-map", `${inputIndices.bgm}:a`);
  }

  args.push("-shortest", "-r", "30", "-pix_fmt", "yuv420p", "-movflags", "+faststart", outputPath);
  await runFfmpeg(args);
  return outputPath;
}

function runFfmpeg(args) {
  return runCommand(ffmpegPath || "ffmpeg", args);
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const process = spawn(command, args, { stdio: "inherit" });

    process.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`ffmpeg exited with code ${code}`));
    });
  });
}

function escapeXml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}
