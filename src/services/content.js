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

function normalizeText(value) {
  return String(value ?? "")
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getOutputLanguageName(language) {
  if (language === "en") {
    return "English";
  }

  if (language === "ja") {
    return "Japanese";
  }

  return "Korean";
}

function isTextAlignedWithLanguage(text, language) {
  const value = normalizeText(text);
  if (!value) {
    return false;
  }

  if (language === "en") {
    return /[a-z]/i.test(value) && !/[가-힣ぁ-ゔァ-ヴー々〆〤一-龯]/.test(value);
  }

  if (language === "ja") {
    return /[ぁ-ゔァ-ヴー々〆〤一-龯]/.test(value);
  }

  return /[가-힣]/.test(value);
}

function trimTopicTitle(value, maxLength = 72) {
  const normalized = normalizeText(value)
    .replace(/^["'\s]+|["'\s]+$/g, "")
    .replace(/[.?!,:;]+$/g, "");

  if (!normalized) {
    return "";
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength).trim()}...`;
}

function defaultTopicByLanguage(language) {
  if (language === "en") {
    return "The one issue that matters most today";
  }

  if (language === "ja") {
    return "今日いちばん 중요한 이슈";
  }

  return "오늘 가장 중요한 핵심 이슈";
}

const instructionHints = [
  "you are",
  "your job",
  "select one",
  "choose one",
  "write",
  "create",
  "generate",
  "channel called",
  "for a youtube",
  "prompt",
  "프롬프트",
  "당신은",
  "해 주세요",
  "해주세요",
  "작성해",
  "생성해",
  "선정해",
  "골라",
  "전략가"
];

const genericStopWords = new Set([
  "you",
  "are",
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "into",
  "about",
  "called",
  "channel",
  "youtube",
  "longform",
  "video",
  "today",
  "select",
  "choose",
  "create",
  "write",
  "generate",
  "please",
  "senior",
  "strategist",
  "content",
  "your",
  "job",
  "high",
  "potential",
  "topic",
  "signal",
  "trigger"
]);

const historyPriorityKeywords = [
  "history", "historical", "empire", "dynasty", "colonial", "legacy", "treaty", "border",
  "war", "civil war", "revolution", "cold war", "regime", "kingdom", "occupation", "annexation",
  "geopolit", "territory", "alliance", "diplom", "sanction", "proxy", "religion", "ethnic",
  "역사", "제국", "왕조", "식민", "조약", "국경", "전쟁", "혁명", "냉전", "정권", "점령", "합병", "영토", "외교"
];

function historyPriorityScore(text) {
  const lower = normalizeText(text).toLowerCase();
  if (!lower) {
    return 0;
  }

  return historyPriorityKeywords.reduce((score, keyword) => {
    return score + (lower.includes(keyword.toLowerCase()) ? 3 : 0);
  }, 0);
}

export function isInstructionLikeTopic(value) {
  const text = normalizeText(value).toLowerCase();

  if (!text) {
    return true;
  }

  if (text.length > 110) {
    return true;
  }

  return instructionHints.some((token) => text.includes(token));
}

export function isWeakResolvedTopic(value) {
  const text = normalizeText(value).toLowerCase();

  return (
    !text
    || /^how did we get here[?!.]*$/i.test(text)
    || /^the one issue that matters most today[?!.]*$/i.test(text)
    || /^오늘 가장 중요한 핵심 이슈[.!?]*$/i.test(text)
    || /^a real, current, major international headline or geopolitical issue[.!?]*$/i.test(text)
  );
}

function extractQuotedText(prompt) {
  const matches = [...String(prompt ?? "").matchAll(/"([^"]{4,80})"/g)]
    .map((match) => normalizeText(match[1]))
    .filter(Boolean)
    .filter((item) => !/^signal trigger[.!?]*$/i.test(item))
    .filter((item) => !/^how did we get here[?!.]*$/i.test(item));

  return matches[0] || "";
}

function extractTopicHint(prompt, language) {
  const text = normalizeText(prompt);
  if (!text) {
    return "";
  }

  const quoted = extractQuotedText(text);
  if (
    quoted &&
    quoted.length >= 6 &&
    !genericStopWords.has(quoted.toLowerCase()) &&
    !isWeakResolvedTopic(quoted) &&
    !isInstructionLikeTopic(quoted)
  ) {
    return trimTopicTitle(quoted);
  }

  const patterns = language === "en"
    ? [
        /\babout\s+(.+?)(?:[.?!]|$)/i,
        /\bon\s+(.+?)(?:[.?!]|$)/i,
        /\bcover\s+(.+?)(?:[.?!]|$)/i
      ]
    : [
        /주제로\s+(.+?)(?:[.?!]|$)/,
        /에 대해\s+(.+?)(?:[.?!]|$)/,
        /관한\s+(.+?)(?:[.?!]|$)/
      ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    const candidate = trimTopicTitle(match?.[1] || "");
    if (
      candidate &&
      candidate.length >= 6 &&
      !genericStopWords.has(candidate.toLowerCase()) &&
      !isWeakResolvedTopic(candidate) &&
      !isInstructionLikeTopic(candidate)
    ) {
      return candidate;
    }
  }

  const compact = text
    .replace(/you are.+?(?=your job|$)/i, "")
    .replace(/your job is to/gi, "")
    .replace(/select one/gi, "")
    .replace(/choose one/gi, "")
    .replace(/high-potential/gi, "")
    .replace(/longform/gi, "")
    .replace(/topic/gi, "")
    .replace(/today/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  if (
    compact &&
    compact.length >= 6 &&
    compact.length <= 70 &&
    !genericStopWords.has(compact.toLowerCase()) &&
    !isWeakResolvedTopic(compact) &&
    !isInstructionLikeTopic(compact)
  ) {
    return trimTopicTitle(compact);
  }

  return "";
}

function extractKeywords(prompt) {
  const tokens = normalizeText(prompt)
    .toLowerCase()
    .replace(/[^a-z0-9가-힣ぁ-んァ-ヶー一-龯\s]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .filter((token) => !genericStopWords.has(token));

  return [...new Set(tokens)].slice(0, 8);
}

async function fetchTrendCandidates(language) {
  const { geo } = normalizeLanguage(language);
  const raw = await googleTrends.dailyTrends({ trendDate: new Date(), geo });
  const parsed = JSON.parse(raw);

  return parsed.default?.trendingSearchesDays?.flatMap((day) =>
    (day.trendingSearches ?? [])
      .map((item) => normalizeText(item.title?.query))
      .filter(Boolean)
  ) ?? [];
}

function pickBestTrend(prompt, trends) {
  if (!trends.length) {
    return "";
  }

  const keywords = extractKeywords(prompt);
  if (!keywords.length) {
    return trends[0];
  }

  let bestTrend = trends[0];
  let bestScore = -1;

  for (const trend of trends) {
    const lower = trend.toLowerCase();
    const score = keywords.reduce((total, keyword) => {
      return total + (lower.includes(keyword) ? 1 : 0);
    }, 0) + historyPriorityScore(trend);

    if (score > bestScore) {
      bestTrend = trend;
      bestScore = score;
    }
  }

  return bestTrend;
}

function buildTopicFromKeywords(prompt, language) {
  const lowerPrompt = normalizeText(prompt).toLowerCase();

  if (lowerPrompt.includes("geopolit")) {
    return language === "en"
      ? "Today's geopolitical flashpoints reshaping global power"
      : "오늘 가장 중요한 지정학 변수";
  }

  if (lowerPrompt.includes("headline") || lowerPrompt.includes("news") || lowerPrompt.includes("국제 뉴스")) {
    return language === "en"
      ? "The global headlines that matter most today"
      : "오늘 가장 중요한 국제 뉴스";
  }

  if (lowerPrompt.includes("semiconductor") || lowerPrompt.includes("반도체")) {
    return language === "en"
      ? "The semiconductor shift the market cannot ignore"
      : "지금 꼭 봐야 할 반도체 핵심 이슈";
  }

  if (lowerPrompt.includes("ai") || lowerPrompt.includes("인공지능")) {
    return language === "en"
      ? "The AI development that matters most right now"
      : "지금 가장 중요한 AI 이슈";
  }

  const keywords = extractKeywords(prompt).slice(0, 4);

  if (!keywords.length) {
    return defaultTopicByLanguage(language);
  }

  if (language === "en") {
    return trimTopicTitle(`${keywords.join(" ")}: what matters now`);
  }

  if (language === "ja") {
    return trimTopicTitle(`${keywords.join(" ")} 지금 봐야 할 핵심 포인트`);
  }

  return trimTopicTitle(`${keywords.join(" ")} 지금 봐야 할 핵심 포인트`);
}

export async function deriveTopicFromPrompt({
  topicPrompt,
  language,
  fallbackTopic
}) {
  const prompt = normalizeText(topicPrompt);
  const fallback = trimTopicTitle(fallbackTopic || "", 72);

  if (!prompt) {
    return fallback || defaultTopicByLanguage(language);
  }

  if (!isInstructionLikeTopic(prompt) && prompt.length <= 80 && isTextAlignedWithLanguage(prompt, language)) {
    return trimTopicTitle(prompt);
  }

  const specialTopic = buildTopicFromKeywords(prompt, language);
  if (specialTopic && specialTopic !== defaultTopicByLanguage(language)) {
    return specialTopic;
  }

  const hint = extractTopicHint(prompt, language);
  if (hint && isTextAlignedWithLanguage(hint, language)) {
    return hint;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";
  const baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";

  if (apiKey) {
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          temperature: 0.4,
          messages: [
            {
              role: "system",
              content: "Turn a creator brief into one concise video topic title. Prefer geopolitics and history-driven topics with strong historical background and current relevance. Return only the final title with no quotes."
            },
            {
              role: "user",
              content: [
                `Language: ${language || "ko"}`,
                "Creator prompt:",
                prompt
              ].join("\n")
            }
          ]
        })
      });

      if (response.ok) {
        const data = await response.json();
        const title = trimTopicTitle(data.choices?.[0]?.message?.content || "");
        if (title) {
          return title;
        }
      }
    } catch {
      // Fall back to trend and keyword heuristics below.
    }
  }

  try {
    const trends = await fetchTrendCandidates(language);
    const selectedTrend = trimTopicTitle(pickBestTrend(prompt, trends));
    if (selectedTrend) {
      return selectedTrend;
    }
  } catch {
    // Fall back to keyword summary below.
  }

  return specialTopic || fallback || defaultTopicByLanguage(language);
}

function buildResearchSummary(topic, ideas, language) {
  const headline = ideas.slice(0, 3).join(", ");

  if (language === "en") {
    return headline
      ? `Research saved around "${topic}". The strongest related signals right now are ${headline}.`
      : `Research saved around "${topic}".`;
  }

  if (language === "ja") {
    return headline
      ? `"${topic}" 기준으로 저장했습니다. 우선 볼 신호는 ${headline} 입니다.`
      : `"${topic}" 기준으로 리서치를 저장했습니다.`;
  }

  return headline
    ? `"${topic}" 기준으로 리서치를 정리했습니다. 우선 볼 신호는 ${headline}입니다.`
    : `"${topic}" 기준으로 리서치를 저장했습니다.`;
}

async function fetchTrendIdeasLegacy({ topicPrompt, topic, language }) {
  const resolvedTopic = trimTopicTitle(topic || "")
    || await deriveTopicFromPrompt({ topicPrompt, language, fallbackTopic: topic });

  try {
    const ideas = (await fetchTrendCandidates(language))
      .sort((left, right) => historyPriorityScore(right) - historyPriorityScore(left))
      .slice(0, 12);

    return {
      source: `google-daily-trends-${normalizeLanguage(language).geo}`,
      selectedTopic: resolvedTopic,
      ideas,
      summary: buildResearchSummary(resolvedTopic, ideas, language)
    };
  } catch {
    const fallbackIdeas = language === "en"
      ? [
          `${resolvedTopic} background`,
          `Why ${resolvedTopic} matters now`,
          `${resolvedTopic} key stakeholders`,
          `What comes next for ${resolvedTopic}`,
          `Viewer questions about ${resolvedTopic}`,
          `${resolvedTopic} episode structure`
        ]
      : [
          `${resolvedTopic} 핵심 배경`,
          `${resolvedTopic} 지금 중요한 이유`,
          `${resolvedTopic} 이해관계자`,
          `${resolvedTopic} 다음 전개`,
          `${resolvedTopic} 시청자 관점 질문`,
          `${resolvedTopic} 영상 구성 포인트`
        ];

    return {
      source: `fallback-${normalizeLanguage(language).geo}`,
      selectedTopic: resolvedTopic,
      ideas: fallbackIdeas,
      summary: buildResearchSummary(resolvedTopic, fallbackIdeas, language)
    };
  }
}

function buildResearchScoutPrompt({ topicPrompt, topic, language, trendIdeas }) {
  const outputLanguage = getOutputLanguageName(language);

  return [
    'You are a story scout for a YouTube channel called "Signal Trigger."',
    "",
    'When the input is "fun story", your job is to find a list of real-world topic ideas that are genuinely interesting, easy to get hooked on, and strong enough to turn into highly watchable longform videos.',
    "",
    "This is NOT about picking the most important topic.",
    "This is NOT about picking the most technical topic.",
    "This is NOT about sounding smart.",
    "",
    "Your job is to find stories that make people instantly curious.",
    "",
    "The topics can come from:",
    "- current news",
    "- history",
    "- war",
    "- politics",
    "- diplomacy",
    "- scandals",
    "- betrayals",
    "- strange alliances",
    "- revenge stories",
    "- failed leaders",
    "- shocking decisions",
    "- old grudges",
    "- disasters caused by one bad move",
    "- real-life stories that sound crazier than fiction",
    "",
    "What makes a good topic:",
    "1. It should instantly make people think:",
    '   - "Wait, what happened?"',
    '   - "No way this is real."',
    '   - "How did this turn out like that?"',
    '   - "That sounds insane."',
    '   - "I want to hear this story."',
    "2. It should be easy to explain to ordinary viewers.",
    "3. It should have strong drama, conflict, irony, or emotional tension.",
    "4. It should have clear storytelling potential.",
    "5. It should NOT feel like homework.",
    "6. It should NOT be full of jargon.",
    "7. It should NOT sound dry, academic, or overly serious.",
    "8. It should feel like a real story people would actually click on.",
    "",
    "Selection preferences:",
    "- wild true stories",
    "- legendary political beefs",
    "- revenge arcs",
    "- strange historical turning points",
    "- secret deals",
    "- massive mistakes",
    "- betrayals",
    "- humiliations",
    "- power grabs",
    "- unintended consequences",
    "- real events with cinematic energy",
    "",
    'If the user says "fun story", generate a list of the most promising topic ideas.',
    "",
    "Output format:",
    "For each topic, provide:",
    "1. Topic Idea",
    "2. Why It Grabs Attention",
    "3. Why It Would Make a Great Video",
    "4. Suggested Hook Angle",
    "",
    "Generate 15 topic ideas.",
    "",
    `Write in clear, vivid, natural ${outputLanguage}.`,
    "Do not sound academic.",
    "Do not sound like a textbook.",
    "Do not sound like a policy analyst.",
    "Make the topics feel juicy, clickable, easy to understand, and highly watchable.",
    "",
    "Return valid JSON only in this shape:",
    '{"topics":[{"topicIdea":"","whyItGrabsAttention":"","whyItWouldMakeAGreatVideo":"","suggestedHookAngle":""}]}',
    "",
    "Input:",
    `Project language: ${outputLanguage}`,
    `Creator input: ${normalizeText(topicPrompt) || "fun story"}`,
    `Current resolved topic: ${normalizeText(topic) || "none"}`,
    `Trend signals: ${trendIdeas.join(" | ") || "none"}`
  ].join("\n");
}

function parseScoutTopics(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.topics)) {
      return parsed.topics
        .map((item) => ({
          topicIdea: normalizeText(item?.topicIdea),
          whyItGrabsAttention: normalizeText(item?.whyItGrabsAttention),
          whyItWouldMakeAGreatVideo: normalizeText(item?.whyItWouldMakeAGreatVideo),
          suggestedHookAngle: normalizeText(item?.suggestedHookAngle)
        }))
        .filter((item) => item.topicIdea);
    }
  } catch {
    // fallback below
  }

  return [];
}

function buildScoutSummary(topicCards, language) {
  const blocks = topicCards.map((item, index) => [
    `${index + 1}. ${item.topicIdea}`,
    `- Why It Grabs Attention: ${item.whyItGrabsAttention}`,
    `- Why It Would Make a Great Video: ${item.whyItWouldMakeAGreatVideo}`,
    `- Suggested Hook Angle: ${item.suggestedHookAngle}`
  ].join("\n"));

  if (blocks.length) {
    return blocks.join("\n\n");
  }

  return language === "en" ? "No scout result was generated." : "스토리 스카우트 결과가 없습니다.";
}

function buildFallbackScoutTopics(resolvedTopic, trendIdeas, language) {
  return trendIdeas.slice(0, 15).map((idea) => {
    if (language === "en") {
      return {
        topicIdea: idea,
        whyItGrabsAttention: `It sounds like a real story with conflict, surprise, and immediate curiosity around ${idea}.`,
        whyItWouldMakeAGreatVideo: `It is easy to follow, naturally dramatic, and can be expanded into a strong longform narrative tied to ${resolvedTopic}.`,
        suggestedHookAngle: `Start with the one detail that makes ${idea} sound stranger, riskier, or more explosive than people expect.`
      };
    }

    return {
      topicIdea: idea,
      whyItGrabsAttention: `${idea} 자체에 갈등과 반전이 보여서 바로 궁금증을 만들 수 있습니다.`,
      whyItWouldMakeAGreatVideo: `${resolvedTopic}와 연결해 길게 풀기 쉽고, 일반 시청자도 이해하기 좋은 이야기 구조를 만들 수 있습니다.`,
      suggestedHookAngle: `${idea}가 왜 생각보다 더 이상하고 위험한 이야기인지 한 줄로 먼저 던지면 좋습니다.`
    };
  });
}

export async function fetchTrendIdeas({ topicPrompt, topic, language }) {
  const resolvedTopic = trimTopicTitle(topic || "")
    || await deriveTopicFromPrompt({ topicPrompt, language, fallbackTopic: topic });

  try {
    const trendIdeas = (await fetchTrendCandidates(language))
      .sort((left, right) => historyPriorityScore(right) - historyPriorityScore(left))
      .slice(0, 15);

    const apiKey = process.env.OPENAI_API_KEY;
    const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";
    const baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";

    if (apiKey) {
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
                content: "You scout highly clickable real-world story ideas for YouTube. Return valid JSON only."
              },
              {
                role: "user",
                content: buildResearchScoutPrompt({
                  topicPrompt,
                  topic: resolvedTopic,
                  language,
                  trendIdeas
                })
              }
            ]
          })
        });

        if (response.ok) {
          const data = await response.json();
          const scoutTopics = parseScoutTopics(data.choices?.[0]?.message?.content || "").slice(0, 15);
          if (scoutTopics.length) {
            return {
              source: `story-scout-${normalizeLanguage(language).geo}`,
              selectedTopic: scoutTopics[0].topicIdea || resolvedTopic,
              ideas: scoutTopics.map((item) => item.topicIdea),
              summary: buildScoutSummary(scoutTopics, language)
            };
          }
        }
      } catch {
        // fall back below
      }
    }

    return {
      source: `google-daily-trends-${normalizeLanguage(language).geo}`,
      selectedTopic: resolvedTopic,
      ideas: trendIdeas,
      summary: buildResearchSummary(resolvedTopic, trendIdeas, language)
    };
  } catch {
    const fallbackIdeas = language === "en"
      ? [
          `${resolvedTopic} background`,
          `Why ${resolvedTopic} matters now`,
          `${resolvedTopic} key stakeholders`,
          `What comes next for ${resolvedTopic}`,
          `Viewer questions about ${resolvedTopic}`,
          `${resolvedTopic} episode structure`,
          `${resolvedTopic} hidden rivalry`,
          `${resolvedTopic} worst decision`,
          `${resolvedTopic} revenge angle`,
          `${resolvedTopic} forgotten trigger`,
          `${resolvedTopic} dangerous turning point`,
          `${resolvedTopic} strange alliance`,
          `${resolvedTopic} humiliation story`,
          `${resolvedTopic} collapse scenario`,
          `${resolvedTopic} insane real story`
        ]
      : [
          `${resolvedTopic} 핵심 배경`,
          `${resolvedTopic} 지금 중요한 이유`,
          `${resolvedTopic} 이해관계자`,
          `${resolvedTopic} 다음 전개`,
          `${resolvedTopic} 시청자 관심 질문`,
          `${resolvedTopic} 영상 구성 포인트`,
          `${resolvedTopic} 숨은 갈등`,
          `${resolvedTopic} 최악의 결정`,
          `${resolvedTopic} 복수 서사`,
          `${resolvedTopic} 잊힌 시작점`,
          `${resolvedTopic} 위험한 분기점`,
          `${resolvedTopic} 이상한 동맹`,
          `${resolvedTopic} 굴욕의 순간`,
          `${resolvedTopic} 붕괴 시나리오`,
          `${resolvedTopic} 믿기 힘든 실화`
        ];
    const scoutTopics = buildFallbackScoutTopics(resolvedTopic, fallbackIdeas, language);

    return {
      source: `fallback-${normalizeLanguage(language).geo}`,
      selectedTopic: scoutTopics[0]?.topicIdea || resolvedTopic,
      ideas: scoutTopics.map((item) => item.topicIdea),
      summary: buildScoutSummary(scoutTopics, language)
    };
  }
}

function getDurationMinutes(durationMinutes) {
  const parsed = Number.parseInt(String(durationMinutes ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10;
}

function cleanupGeneratedScript(script) {
  return String(script ?? "")
    .replace(/^\s*(intro|introduction|hook|body|main body|conclusion|closing|outro)\s*[:\-]\s*/gim, "")
    .replace(/^\s*(인트로|도입|본론|결론|마무리|아웃트로)\s*[:\-]\s*/gim, "")
    .replace(/^\s*[\[(]?\s*(intro music|music|bgm|background music|dramatic music|opening music|intro sfx)\s*[\])]?\s*$/gim, "")
    .replace(/^\s*[\[(]?\s*(인트로 음악|음악|브금|배경음악|오프닝 음악)\s*[\])]?\s*$/gim, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const editorialScenePromptBase = [
  'You are a visual prompt generator for a YouTube longform channel called "Signal Trigger."',
  "",
  "Your job is to turn a narration script into scene-by-scene AI image prompts that feel bold, vivid, pop, dramatic, eye-catching, and highly clickable.",
  "",
  "This is NOT bland historical illustration.",
  "This is NOT quiet documentary realism.",
  "This is NOT boring textbook imagery.",
  "",
  "The goal is to make every scene visually alive and engaging while still matching the story.",
  "",
  "The style should feel like:",
  "- bold pop-art political cartoon",
  "- vivid game-like visual punch",
  "- dramatic poster illustration",
  "- high emotional tension",
  "- cinematic framing",
  "- sharp, modern, scroll-stopping visual storytelling",
  "- colorful arcade-like energy that still fits geopolitics",
  "",
  "Core rules:",
  "1. Each prompt must clearly match the meaning and mood of the script section.",
  "2. The image must feel visually exciting, not flat, sleepy, or generic.",
  "3. Use stronger composition, stronger character reactions, stronger symbolic imagery, and stronger tension.",
  "4. The style must stay serious, sharp, and politically charged, but more vivid, playful in surface energy, and more visually aggressive than a normal editorial illustration.",
  "5. Use vivid contrast and striking focal points where appropriate, especially with tones like bright red, electric blue, neon yellow, hot orange, deep black shadow, glossy highlights, and saturated pop color blocks.",
  "6. Some scenes should deliberately feel more provocative, dangerous, tense, or shocking if it fits the script.",
  "7. Use visual metaphor when it makes the scene more powerful, but keep it clear and readable.",
  "8. If the script is abstract, transform it into a symbolic but instantly understandable visual.",
  "9. Keep the look consistent across the whole video.",
  "10. Avoid childish comedy, meme energy, anime style, superhero comic style, fantasy style, or random surrealism. Game-inspired pop energy is allowed if the political meaning stays clear.",
  "11. Avoid weak compositions, empty backgrounds, dull staging, lifeless faces, and passive scenes.",
  "12. The images should feel like they are made to stop the scroll and pull the viewer into the story instantly.",
  "13. Output prompts only.",
  "14. Write in English.",
  "",
  "Preferred visual elements when relevant:",
  "- leaders confronting each other",
  "- angry crowds",
  "- riots",
  "- missile silhouettes",
  "- war room tension",
  "- symbolic flames",
  "- shattered borders",
  "- collapsing statues",
  "- broken treaties",
  "- dramatic handshakes",
  "- secret meetings",
  "- nuclear anxiety",
  "- betrayal imagery",
  "- maps under pressure",
  "- flags in tension",
  "- intense close-ups",
  "- powerful silhouette staging",
  "- bold icon-like props",
  "- bright layered backgrounds",
  "- exaggerated readable shapes",
  "",
  "Global visual baseline for every prompt:",
  "bold pop-art political cartoon, vivid game-like visual impact, dramatic composition, sharp linework, thick readable shapes, strong contrast, saturated color blocks, bright focal point, serious geopolitical tone, cinematic lighting, textured shading, striking expressions, clean subject separation, highly clickable image design, emotionally charged atmosphere, modern poster-like energy",
  "",
  "Variety rule:",
  "Avoid weak portrait repetition. Use diverse visual subject matter such as maps, riots, borders, war rooms, ports, military hardware, collapsing monuments, pressured flags, shattered agreements, trade routes, industry, archives, and city power centers whenever they better fit the narration.",
  "Only use a human face as the main focus when a specific leader, diplomat, soldier, or crowd reaction is essential to the scene meaning."
].join("\n");

function buildSceneVisualAngle(paragraph, index) {
  const text = normalizeText(paragraph).toLowerCase();

  if (/nuclear|missile|warhead|핵|미사일/.test(text)) {
    return "missile silo, launch control room, nuclear map table, warning lights, geopolitical tension";
  }

  if (/sanction|trade|economy|market|oil|gas|supply chain|제재|무역|경제|원유|가스/.test(text)) {
    return "trade route map, cargo port, oil facility, currency chart, sanctions documents, industrial backdrop";
  }

  if (/border|territory|sea|strait|navy|fleet|island|국경|영해|해협|함대/.test(text)) {
    return "border checkpoint, contested sea map, naval vessels, surveillance view, strategic geography";
  }

  if (/protest|revolution|uprising|riot|coup|정권|혁명|시위|쿠데타/.test(text)) {
    return "street protest, state building, riot police silhouette, torn flags, regime pressure";
  }

  if (/diplom|summit|negotiat|treaty|alliance|유럽연합|정상회담|외교|협상|동맹/.test(text)) {
    return "summit table, handshake under tension, treaty papers, flags, guarded diplomatic chamber";
  }

  if (/history|empire|legacy|colonial|archival|historical|역사|제국|식민/.test(text)) {
    return "archival documents, faded map, old palace or fortress, historical uniforms, layered timeline imagery";
  }

  const fallbackAngles = [
    "strategic world map with highlighted flashpoints and state symbols",
    "government war room with screens, maps, and tense officials",
    "industrial and military infrastructure under geopolitical pressure",
    "symbolic statecraft scene with flags, documents, and hard shadows"
  ];

  return fallbackAngles[index % fallbackAngles.length];
}

function buildEditorialScenePrompt({ topic, paragraph, tone, format, colors, customPrompt, index }) {
  return [
    editorialScenePromptBase,
    "",
    `Topic: ${normalizeText(topic) || "Global geopolitics"}`,
    `Narration section: ${normalizeText(paragraph)}`,
    `Tone: ${normalizeText(tone) || "serious, intelligent, dramatic"}`,
    `Primary visual angle: ${buildSceneVisualAngle(paragraph, index)}`,
    `Frame: ${format === "landscape" ? "16:9 wide composition" : "9:16 vertical composition"}`,
    `Color palette: ${colors.join(", ")}`,
    "Composition rule: avoid single-person portrait unless absolutely necessary for the scene meaning.",
    customPrompt ? `Channel direction: ${normalizeText(customPrompt)}` : "",
    "",
    "Output:",
    "One single image prompt in English only."
  ].filter(Boolean).join("\n");
}

function buildFallbackParagraphs({ topic, language, research, customPrompt, tone, durationMinutes }) {
  const safeTopic = trimTopicTitle(topic || "", 80) || defaultTopicByLanguage(language);
  const ideas = (research?.ideas ?? []).slice(0, 6);
  const minutes = getDurationMinutes(durationMinutes);
  const bodyCount = Math.max(8, Math.min(22, minutes * 2));

  if (language === "en") {
    const paragraphs = [
      `${safeTopic} did not start where most people think it did, and the part that still drives it now is older, darker, and harder to forget.`,
      `To understand why ${safeTopic} matters right now, we have to follow the pressure trail through ${ideas.join(", ") || "the key old decisions people still live with"}.`
    ];

    for (let index = 0; index < bodyCount; index += 1) {
      const idea = ideas[index % Math.max(ideas.length, 1)] || safeTopic;
      paragraphs.push(
        `${idea} was not just another event inside ${safeTopic}. It changed incentives, hardened memories, and pushed the next move in a way people still feel now.`
      );
    }

    paragraphs.push(`That is why ${safeTopic} now feels less like a random headline and more like an old story reaching back for one more round.`);

    if (customPrompt) {
      paragraphs.push(`Additional direction: ${customPrompt}`);
    }

    return paragraphs;
  }

  const paragraphs = [
    `이번 영상에서는 ${safeTopic}를 약 ${minutes}분 분량으로 풀어갑니다. 도입, 본문, 마무리가 분명하게 이어지도록 구성합니다.`,
    `${safeTopic}를 추상적으로 설명하지 않고 ${ideas.join(", ") || "최근 시청자 관심 질문"}과 연결해서 왜 지금 봐야 하는지부터 짚습니다.`
  ];

  for (let index = 0; index < bodyCount; index += 1) {
    const idea = ideas[index % Math.max(ideas.length, 1)] || safeTopic;
    paragraphs.push(
      `${idea}를 중심으로 현재 상황, 중요한 이유, 앞으로의 전개, 그리고 시청자가 바로 이해해야 할 핵심만 ${tone || "정보형"} 톤으로 설명합니다.`
    );
  }

  paragraphs.push("마지막에는 오늘 꼭 기억할 핵심, 다음에 볼 포인트, 그리고 영상 설명란에 넣기 좋은 정리 문장까지 자연스럽게 마무리합니다.");

  if (customPrompt) {
    paragraphs.push(`추가 지시 반영 메모: ${customPrompt}`);
  }

  return paragraphs;
}

function fallbackScript({ topic, tone, language, research, customPrompt, durationMinutes }) {
  return cleanupGeneratedScript(buildFallbackParagraphs({
    topic,
    tone,
    language,
    research,
    customPrompt,
    durationMinutes
  }).join("\n\n"));
}

export async function generateScript({ topic, tone, language, research, customPrompt, durationMinutes }) {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";
  const baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  const minutes = getDurationMinutes(durationMinutes);
  const resolvedTopic = trimTopicTitle(topic || "", 100) || defaultTopicByLanguage(language);
  const outputLanguage = getOutputLanguageName(language);

  if (!apiKey) {
    return fallbackScript({ topic: resolvedTopic, tone, language, research, customPrompt, durationMinutes: minutes });
  }

  const headline = resolvedTopic;
  const hiddenPastStory = normalizeText(research?.summary) || "No saved research summary. Infer the hidden past story from the headline and any keywords.";
  const keyPastEvents = (research?.ideas ?? []).length
    ? (research.ideas ?? []).map((idea) => `- ${normalizeText(idea)}`).join("\n")
    : "- No saved past events. Infer the most important historical chain from the headline.";
  const prompt = [
    'You are a master longform scriptwriter for a YouTube channel called "Signal Trigger."',
    "",
    "Your job is to write a highly engaging 10-20 minute YouTube narration script based on a current headline and the hidden old story behind it.",
    "",
    "This is NOT a dry news explainer.",
    "This is NOT a lecture.",
    "This is NOT a textbook summary.",
    "This is NOT a policy analysis.",
    "",
    "This channel tells real history like a gripping story.",
    "The target audience is viewers in their 20s and 30s.",
    "The script must feel smart, fast, clear, trendy, and easy to follow.",
    "",
    "The viewer should feel:",
    "\"Wait, what?\"",
    "\"No way this started that far back.\"",
    "\"So THAT’S why this is happening.\"",
    "\"How did this spiral into this?\"",
    "\"I need to hear the rest.\"",
    "",
    "Your mission:",
    "Take a current headline and turn it into a tense, dramatic, addictive longform script that explains the hidden historical chain behind it.",
    "",
    "The script must feel like:",
    "- a dark historical documentary",
    "- a geopolitical thriller",
    "- an old betrayal exploding in the present",
    "- a story of revenge, fear, pride, humiliation, ambition, collapse, and consequences that never died",
    "",
    "Core writing rules:",
    "1. Hook the viewer immediately in the first 2–4 sentences.",
    "2. The first 30 seconds must feel like the opening of a dangerous secret from history, not a normal news explanation.",
    "3. Do NOT begin with generic context, definitions, or broad statements.",
    "4. Do NOT start with “In today’s video” or anything similar.",
    "5. Start with tension, irony, shock, betrayal, danger, or a question that instantly creates curiosity.",
    "6. The opening should feel like:",
    "   - a buried grudge resurfacing",
    "   - an old betrayal exploding into the present",
    "   - a forgotten decision that poisoned the future",
    "7. Write like you are telling the viewer the true story behind today’s headline — the part most people never hear.",
    "8. Keep the language clear, vivid, natural, and spoken.",
    "9. Use easier spoken language, shorter sentences, and cleaner wording than a typical documentary script.",
    "10. Prioritize momentum, curiosity, emotional tension, and narrative flow over formal explanation.",
    "11. Every paragraph should make the viewer want the next paragraph.",
    "12. Constantly connect the past to the present headline.",
    "13. Make cause and effect obvious:",
    "   - what happened",
    "   - why it mattered",
    "   - who never forgot",
    "   - how it came back",
    "14. Focus on the human core of history:",
    "   - betrayal",
    "   - fear",
    "   - humiliation",
    "   - revenge",
    "   - paranoia",
    "   - survival",
    "   - collapse",
    "   - power",
    "15. Avoid academic tone, bureaucratic tone, policy-paper tone, or boring news-anchor tone.",
    "16. Avoid filler, repetition, dead transitions, and overlong explanations.",
    "17. Keep it serious, cinematic, easy to follow, and emotionally immediate.",
    "18. Keep the pacing alive. Do not let the energy sag.",
    "19. The final section should make today’s headline feel tragic, inevitable, or deeply unsettling.",
    "20. The ending should leave the viewer with the feeling:",
    "\"This was never really over.\"",
    "",
    "Structure:",
    "- Open with a hard hook",
    "- Briefly introduce the current headline",
    "- Pivot quickly into the deeper historical question",
    "- Tell the old story like it is unfolding",
    "- Build escalation through the key past events",
    "- Bring everything back to the present",
    "- End with a sharp, haunting closing",
    "",
    "Output requirements:",
    `- Write in natural spoken ${outputLanguage} for YouTube narration`,
    "- Write as a full script only",
    "- No bullet points inside the script",
    "- No section labels",
    "- No robotic transitions",
    "- No generic intro",
    "- No fake hype",
    "- No academic phrasing",
    "- Make it feel intelligent, cinematic, addictive, and easy to understand",
    "- Keep the language simple enough that a casual viewer can follow every turn",
    "- Favor punchy, spoken rhythm over long formal sentences",
    "",
    "Most important writing principle:",
    "Do not explain first.",
    "Intrigue first, story second, explanation third.",
    "",
    "Additional production rules:",
    `- Match roughly ${minutes} minutes of spoken runtime`,
    "- Keep it as one continuous narration flow",
    "- Use paragraph breaks",
    "- Do not label sections such as Intro, Body, Conclusion, 인트로, 본론, 결론",
    "- Do not include music cues or stage directions such as [Intro music], [BGM], [Music]",
    tone ? `- Preferred voice tone: ${tone}` : "",
    customPrompt ? `- Additional channel direction: ${customPrompt}` : "",
    "",
    "Input:",
    `Current Headline: ${headline}`,
    `Hidden Past Story: ${hiddenPastStory}`,
    `Key Past Events:\n${keyPastEvents}`,
    `Target Length: ${minutes} minutes`
  ].filter(Boolean).join("\n");

  const systemPrompt = [
    "You write YouTube longform narration scripts.",
    `Return only the finished script in natural spoken ${outputLanguage}.`,
    "No bullet points. No section labels. No stage directions.",
    "Keep the pacing fast, the wording clear, and the tone emotionally engaging for viewers in their 20s and 30s."
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
            content: systemPrompt
          },
          {
            role: "user",
            content: prompt
          }
        ]
      })
    });

    if (!response.ok) {
      return fallbackScript({ topic: resolvedTopic, tone, language, research, customPrompt, durationMinutes: minutes });
    }

    const data = await response.json();
    return cleanupGeneratedScript(data.choices?.[0]?.message?.content?.trim())
      || fallbackScript({ topic: resolvedTopic, tone, language, research, customPrompt, durationMinutes: minutes });
  } catch {
    return fallbackScript({ topic: resolvedTopic, tone, language, research, customPrompt, durationMinutes: minutes });
  }
}

export function getTargetSceneCount(durationMinutes) {
  return Math.max(1, getDurationMinutes(durationMinutes) * 10);
}

function splitScriptIntoSceneNarrations(script, durationMinutes) {
  const normalizedScript = String(script ?? "")
    .replace(/\r\n/g, "\n")
    .trim();

  if (!normalizedScript) {
    return [];
  }

  const targetScenes = getTargetSceneCount(durationMinutes);
  const words = normalizedScript.split(/\s+/).filter(Boolean);

  if (!words.length) {
    return [];
  }

  return Array.from({ length: targetScenes }, (_, index) => {
    const start = Math.floor((index * words.length) / targetScenes);
    const end = Math.floor(((index + 1) * words.length) / targetScenes);
    const safeEnd = end > start ? end : Math.min(words.length, start + 1);
    return words.slice(start, safeEnd).join(" ").trim();
  }).filter(Boolean);
}

export function planScenes({ script, topic, tone, format, styleProfile, customPrompt, durationMinutes }) {
  const narrations = splitScriptIntoSceneNarrations(script, durationMinutes);

  const colors = styleProfile?.palette ?? ["#111827", "#2563eb", "#f8fafc"];
  const safeTopic = trimTopicTitle(topic || "", 40) || "Longform topic";

  return narrations.map((paragraph, index) => ({
    index,
    title: `${safeTopic} ${index + 1}`,
    narration: paragraph,
    durationSec: 6,
    imagePrompt: buildEditorialScenePrompt({
      topic,
      paragraph,
      tone,
      format,
      colors,
      customPrompt,
      index
    }),
    transition: index % 2 === 0 ? "fade" : "slide",
    variationSeed: `${safeTopic}-${index + 1}-${Date.now()}`
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
    return `현재 프로젝트 상태는 ${project.status}입니다. 채널 웹훅이 연결되어 있고 예약 시간이 지나면 자동 업로드 흐름으로 넘어갑니다.`;
  }

  if (lower.includes("장면")) {
    return "장면 재생성 버튼을 누르면 해당 장면 이미지만 다시 만들고 전체 렌더 결과를 갱신합니다.";
  }

  if (lower.includes("스타일")) {
    return "스타일 레퍼런스 이미지가 있으면 색상 팔레트를 추출해서 장면 프롬프트에 반영합니다.";
  }

  return `현재 장면 수는 ${project.scenes.length}개이고 프로젝트 상태는 ${project.status}입니다. 질문을 더 구체적으로 입력하면 바로 안내해 드립니다.`;
}
