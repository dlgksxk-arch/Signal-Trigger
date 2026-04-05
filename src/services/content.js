import fs from "node:fs";
import googleTrends from "google-trends-api";
import sharp from "sharp";

function normalizeLanguage(language) {
  if (language === "ja") {
    return { geo: "JP" };
  }

  if (language === "en") {
    return { geo: "US" };
  }

  return { geo: "KR" };
}

function defaultTopicByLanguage(language) {
  if (language === "en") {
    return "productivity habits";
  }

  if (language === "ja") {
    return "睡眠の質を上げる習慣";
  }

  return "수면의 질을 높이는 습관";
}

export async function fetchTrendIdeas(topic, language) {
  const { geo } = normalizeLanguage(language);
  const seedTopic = topic?.trim() || defaultTopicByLanguage(language);

  try {
    const raw = await googleTrends.dailyTrends({ trendDate: new Date(), geo });
    const parsed = JSON.parse(raw);
    const ideas = parsed.default?.trendingSearchesDays?.flatMap((item) =>
      (item.trendingSearches ?? []).map((search) => search.title?.query).filter(Boolean)
    ) ?? [];

    return {
      source: `google-daily-trends-${geo}`,
      ideas: ideas.slice(0, 10),
      summary: `${seedTopic}와 연결해 볼 만한 실시간 키워드를 모았습니다.`
    };
  } catch {
    return {
      source: `fallback-${geo}`,
      ideas: [
        `${seedTopic} 최신 이슈`,
        `${seedTopic} 입문 가이드`,
        `${seedTopic} 실수 방지`,
        `${seedTopic} 비교 분석`,
        `${seedTopic} 실제 사례`
      ],
      summary: `${seedTopic} 기준으로 기본 리서치 목록을 만들었습니다.`
    };
  }
}

function fallbackScript({ topic, language, research, customPrompt }) {
  const safeTopic = topic?.trim() || defaultTopicByLanguage(language);
  const ideas = (research?.ideas ?? []).slice(0, 5).join(", ");

  const lines = language === "en"
    ? [
        `Today we break down ${safeTopic} in a simple and practical way.`,
        `First, we explain why ${safeTopic} matters now and how it connects to current trends such as ${ideas}.`,
        "Next, we turn this into a step-by-step guide that a beginner can follow immediately.",
        "Then we compare common mistakes, useful examples, and realistic choices.",
        "Finally, we summarize what to do today and what to avoid."
      ]
    : language === "ja"
      ? [
          `今回は${safeTopic}を、すぐ使える形で分かりやすく整理します。`,
          `まず、${safeTopic}が今なぜ重要なのかと、${ideas}のような関連話題を見ていきます。`,
          "次に、初心者でもそのまま使えるように手順を細かく分けて説明します。",
          "よくある失敗、現実的な判断基準、実例を比べながら理解しやすくまとめます。",
          "最後に、今日すぐやることと避けることを短く整理します。"
        ]
      : [
          `이번 영상에서는 ${safeTopic}를 쉽고 실용적으로 정리합니다.`,
          `먼저 ${safeTopic}가 왜 지금 중요한지와 ${ideas} 같은 관련 흐름을 함께 봅니다.`,
          "다음으로 초보자도 바로 따라 할 수 있게 단계별로 나눠 설명합니다.",
          "이후 자주 하는 실수와 실제 선택 기준을 비교해서 정리합니다.",
          "마지막으로 오늘 바로 할 일과 피해야 할 점을 짧게 마무리합니다."
        ];

  if (customPrompt) {
    lines.push(`추가 지시: ${customPrompt}`);
  }

  return lines.join("\n\n");
}

export async function generateScript({ topic, tone, language, research, customPrompt }) {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";
  const baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";

  if (!apiKey) {
    return fallbackScript({ topic, language, research, customPrompt });
  }

  const prompt = `
주제: ${topic || defaultTopicByLanguage(language)}
톤: ${tone}
언어: ${language}
트렌드 참고: ${(research?.ideas ?? []).join(", ")}
추가 지시: ${customPrompt || "없음"}

조건:
- 유튜브 롱폼 내레이션 대본
- 도입, 본론, 정리 구조
- 문단 단위 구분
- 반복 최소화
`.trim();

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        temperature: 0.9,
        messages: [
          {
            role: "system",
            content: "당신은 유튜브 롱폼 영상 대본 작성자입니다."
          },
          {
            role: "user",
            content: prompt
          }
        ]
      })
    });

    if (!response.ok) {
      return fallbackScript({ topic, language, research, customPrompt });
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content?.trim() || fallbackScript({ topic, language, research, customPrompt });
  } catch {
    return fallbackScript({ topic, language, research, customPrompt });
  }
}

export function planScenes({ script, topic, tone, format, styleProfile, customPrompt }) {
  const paragraphs = script
    .split(/\n{2,}/)
    .map((line) => line.trim())
    .filter(Boolean);

  const colors = styleProfile?.palette ?? ["#111827", "#2563eb", "#f8fafc"];

  return paragraphs.slice(0, 10).map((paragraph, index) => ({
    index,
    title: `${topic} ${index + 1}`,
    narration: paragraph,
    durationSec: Math.max(6, Math.round(paragraph.length / 18)),
    imagePrompt: [
      topic,
      tone,
      customPrompt || "",
      format === "landscape" ? "16:9 composition" : "9:16 composition",
      `dominant colors ${colors.join(", ")}`,
      "cinematic lighting",
      "high detail",
      "no text"
    ].filter(Boolean).join(", "),
    transition: index % 2 === 0 ? "fade" : "slide",
    variationSeed: `${topic}-${index + 1}-${Date.now()}`
  }));
}

export async function buildStyleProfile(styleReferencePath, format) {
  if (!styleReferencePath || !fs.existsSync(styleReferencePath)) {
    return {
      source: "default",
      palette: format === "landscape"
        ? ["#111827", "#2563eb", "#f8fafc"]
        : ["#111827", "#e11d48", "#f8fafc"],
      mood: "clean",
      framing: format
    };
  }

  const image = sharp(styleReferencePath);
  const stats = await image.stats();
  const dominant = stats.dominant;
  const channels = stats.channels.slice(0, 3).map((channel) => Math.round(channel.mean));

  return {
    source: "reference-image",
    palette: [
      rgbToHex(dominant.r, dominant.g, dominant.b),
      rgbToHex(channels[0], channels[1], channels[2]),
      "#f8fafc"
    ],
    mood: "reference",
    framing: format
  };
}

function rgbToHex(r, g, b) {
  return `#${[r, g, b].map((value) => Number(value).toString(16).padStart(2, "0")).join("")}`;
}

export function answerHelpQuestion(project, question) {
  const lower = (question || "").toLowerCase();

  if (lower.includes("업로드")) {
    return `현재 프로젝트 상태는 ${project.status}입니다. 채널 웹훅이 있으면 예약 시각에 자동 호출됩니다.`;
  }

  if (lower.includes("장면")) {
    return "장면별 재생성 버튼을 누르면 해당 장면 이미지만 다시 만들고 전체 영상을 다시 렌더링합니다.";
  }

  if (lower.includes("스타일")) {
    return "스타일 레퍼런스 이미지가 있으면 색상 팔레트를 추출해서 장면 프롬프트에 반영합니다.";
  }

  return `현재 장면 수는 ${project.scenes.length}개이고 상태는 ${project.status}입니다. 질문을 더 짧게 적으면 바로 안내할 수 있습니다.`;
}
