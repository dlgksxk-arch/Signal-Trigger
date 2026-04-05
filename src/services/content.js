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
    return "Create a practical longform explainer about building better daily habits.";
  }

  if (language === "ja") {
    return "生活の質を上げるための習慣を分かりやすく解説してください。";
  }

  return "생활의 질을 높이는 습관을 실제 사례 중심으로 설명해 주세요.";
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
      ideas: ideas.slice(0, 12),
      summary: `${seedTopic}와 연결할 수 있는 최근 관심 키워드를 모았습니다.`
    };
  } catch {
    return {
      source: `fallback-${geo}`,
      ideas: [
        `${seedTopic} 최신 이슈`,
        `${seedTopic} 초보자 가이드`,
        `${seedTopic} 실수 사례`,
        `${seedTopic} 비교 포인트`,
        `${seedTopic} 실제 후기`,
        `${seedTopic} 추천 방법`
      ],
      summary: `${seedTopic}를 기준으로 기본 리서치 목록을 만들었습니다.`
    };
  }
}

function getDurationMinutes(durationMinutes) {
  const parsed = Number.parseInt(String(durationMinutes ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10;
}

function buildFallbackParagraphs({ topic, language, research, customPrompt, tone, durationMinutes }) {
  const safeTopic = topic?.trim() || defaultTopicByLanguage(language);
  const ideas = (research?.ideas ?? []).slice(0, 6);
  const minutes = getDurationMinutes(durationMinutes);
  const bodyCount = Math.max(8, Math.min(22, minutes * 2));

  if (language === "en") {
    const paragraphs = [
      `In this video, we unpack ${safeTopic} in a practical way that keeps the full ${minutes}-minute runtime engaging from start to finish.`,
      `Instead of stopping at abstract theory, we will connect ${safeTopic} to real search interest such as ${ideas.join(", ") || "recent audience questions"} and turn it into usable advice.`
    ];

    for (let index = 0; index < bodyCount; index += 1) {
      const idea = ideas[index % Math.max(ideas.length, 1)] || safeTopic;
      paragraphs.push(
        `Point ${index + 1}. We look at ${idea} through the lens of ${safeTopic}, explain why people get stuck here, and show a simple way to improve results without overcomplicating the process.`
      );
    }

    paragraphs.push("To close, we summarize what to start today, what to avoid this week, and how viewers can measure real progress over time.");

    if (customPrompt) {
      paragraphs.push(`Additional direction to reflect in tone and structure: ${customPrompt}`);
    }

    return paragraphs;
  }

  if (language === "ja") {
    const paragraphs = [
      `この動画では、${safeTopic}を約${minutes}分の長さで、最後まで理解しやすい流れに整理して解説します。`,
      `${safeTopic}を単なる一般論で終わらせず、${ideas.join("、") || "最近の関心テーマ"}と結び付けながら、すぐ使える形に落とし込みます。`
    ];

    for (let index = 0; index < bodyCount; index += 1) {
      const idea = ideas[index % Math.max(ideas.length, 1)] || safeTopic;
      paragraphs.push(
        `ポイント${index + 1}では、${idea}を切り口にして、よくある失敗、続かない理由、そして無理なく実践するための現実的な方法を順番に説明します。`
      );
    }

    paragraphs.push("最後に、今日から始めること、避けること、そして継続のために確認すべき基準を簡潔にまとめます。");

    if (customPrompt) {
      paragraphs.push(`追加指示: ${customPrompt}`);
    }

    return paragraphs;
  }

  const paragraphs = [
    `이번 영상에서는 ${safeTopic}를 약 ${minutes}분 분량으로 풀어서 설명합니다. 끝까지 들었을 때 바로 적용할 수 있도록 실제 흐름 중심으로 정리합니다.`,
    `${safeTopic}를 단순한 정보 나열로 끝내지 않고, ${ideas.join(", ") || "최근 관심 키워드"}와 연결해서 왜 지금 중요한지부터 짚어 보겠습니다.`
  ];

  for (let index = 0; index < bodyCount; index += 1) {
    const idea = ideas[index % Math.max(ideas.length, 1)] || safeTopic;
    paragraphs.push(
      `포인트 ${index + 1}. ${idea}를 기준으로 사람들이 자주 놓치는 부분, 바로 실행 가능한 방법, 실제로 오래 유지하는 요령을 순서대로 설명합니다. 톤은 ${tone || "정보형"} 기준으로 유지합니다.`
    );
  }

  paragraphs.push("마지막에는 오늘 바로 실천할 한 가지, 이번 주 안에 점검할 한 가지, 그리고 피해야 할 실수를 짧게 정리하며 마무리합니다.");

  if (customPrompt) {
    paragraphs.push(`추가 지시 반영 메모: ${customPrompt}`);
  }

  return paragraphs;
}

function fallbackScript({ topic, tone, language, research, customPrompt, durationMinutes }) {
  return buildFallbackParagraphs({
    topic,
    tone,
    language,
    research,
    customPrompt,
    durationMinutes
  }).join("\n\n");
}

export async function generateScript({ topic, tone, language, research, customPrompt, durationMinutes }) {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";
  const baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  const minutes = getDurationMinutes(durationMinutes);

  if (!apiKey) {
    return fallbackScript({ topic, tone, language, research, customPrompt, durationMinutes: minutes });
  }

  const prompt = [
    `주제 프롬프트: ${topic || defaultTopicByLanguage(language)}`,
    `톤: ${tone || "정보형"}`,
    `언어: ${language}`,
    `목표 영상 길이: 약 ${minutes}분`,
    `리서치 키워드: ${(research?.ideas ?? []).join(", ") || "없음"}`,
    `추가 지시: ${customPrompt || "없음"}`,
    "",
    "조건:",
    "- 유튜브 롱폼 내레이션 대본 형식",
    "- 도입, 본문, 마무리가 분명해야 함",
    `- 약 ${minutes}분 분량에 맞는 밀도로 작성`,
    "- 문단 단위로 구분",
    "- 실제 사례, 실수 포인트, 실행 팁 포함",
    "- 군더더기 없는 문장으로 작성"
  ].join("\n");

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        temperature: 0.8,
        messages: [
          {
            role: "system",
            content: "당신은 유튜브 롱폼 영상용 내레이션 대본 작성자입니다."
          },
          {
            role: "user",
            content: prompt
          }
        ]
      })
    });

    if (!response.ok) {
      return fallbackScript({ topic, tone, language, research, customPrompt, durationMinutes: minutes });
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content?.trim()
      || fallbackScript({ topic, tone, language, research, customPrompt, durationMinutes: minutes });
  } catch {
    return fallbackScript({ topic, tone, language, research, customPrompt, durationMinutes: minutes });
  }
}

export function planScenes({ script, topic, tone, format, styleProfile, customPrompt }) {
  const paragraphs = script
    .split(/\n{2,}/)
    .map((line) => line.trim())
    .filter(Boolean);

  const colors = styleProfile?.palette ?? ["#111827", "#2563eb", "#f8fafc"];
  const maxScenes = Math.min(20, Math.max(8, paragraphs.length));

  return paragraphs.slice(0, maxScenes).map((paragraph, index) => ({
    index,
    title: `${topic.split(/\r?\n/)[0].slice(0, 40)} ${index + 1}`,
    narration: paragraph,
    durationSec: Math.max(7, Math.round(paragraph.length / 14)),
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
    return `현재 프로젝트 상태는 ${project.status}입니다. 채널 웹훅이 연결되어 있고 예약 시간이 지나면 자동 업로드 흐름으로 넘길 수 있습니다.`;
  }

  if (lower.includes("장면")) {
    return "장면 재생성 버튼을 누르면 해당 장면 이미지만 다시 만들고 전체 렌더 결과도 갱신합니다.";
  }

  if (lower.includes("스타일")) {
    return "스타일 레퍼런스 이미지가 있으면 색상 팔레트를 추출해서 장면 프롬프트에 반영합니다.";
  }

  return `현재 장면 수는 ${project.scenes.length}개이고 프로젝트 상태는 ${project.status}입니다. 질문을 더 구체적으로 입력하면 바로 안내할 수 있습니다.`;
}
