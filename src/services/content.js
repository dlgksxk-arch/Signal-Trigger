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
    return "餓딀뿥?꾠걾?겹굯 以묒슂???댁뒋";
  }

  return "?ㅻ뒛 媛??以묒슂???듭떖 ?댁뒋";
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
  "써줘",
  "설명해",
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
  "??궗", "?쒓뎅", "?뺤“", "?앸?", "議곗빟", "援?꼍", "?꾩웳", "?곷챸", "?됱쟾", "?뺢텒", "?먮졊", "?⑸퀝", "?곹넗", "?멸탳"
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
  const weakKoreanDefault = normalizeText(defaultTopicByLanguage("ko")).toLowerCase();

  return (
    !text
    || /^how did we get here[?!.]*$/i.test(text)
    || /^the one issue that matters most today[?!.]*$/i.test(text)
    || text === weakKoreanDefault
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
        /다뤄줘\s+(.+?)(?:[.?!]|$)/,
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
    .replace(/[^a-z0-9가-힣ぁ-ゔァ-ヴー々〆〤一-龯\s]/g, " ")
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
      : "오늘의 지정학 변수";
  }

  if (lowerPrompt.includes("headline") || lowerPrompt.includes("news") || lowerPrompt.includes("국제 뉴스")) {
    return language === "en"
      ? "The global headlines that matter most today"
      : "오늘의 국제 뉴스";
  }

  if (lowerPrompt.includes("semiconductor") || lowerPrompt.includes("반도체")) {
    return language === "en"
      ? "The semiconductor shift the market cannot ignore"
      : "지금 봐야 할 반도체 이슈";
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
    return trimTopicTitle(`${keywords.join(" ")} 今いちばん大事な話`);
  }

  return trimTopicTitle(`${keywords.join(" ")} 지금 봐야 할 이슈`);
}

function buildBroadSubjectFromPrompt(prompt, language) {
  const lowerPrompt = normalizeText(prompt).toLowerCase();

  if (lowerPrompt.includes("geopolit")) {
    return language === "en" ? "Geopolitics" : "지정학";
  }

  if (lowerPrompt.includes("headline") || lowerPrompt.includes("news") || lowerPrompt.includes("breaking")) {
    return language === "en" ? "Current global news" : "국제 뉴스";
  }

  if (lowerPrompt.includes("semiconductor")) {
    return language === "en" ? "Semiconductor rivalry" : "반도체 경쟁";
  }

  if (lowerPrompt.includes("ai")) {
    return language === "en" ? "AI power race" : "AI 경쟁";
  }

  const keywords = extractKeywords(prompt).slice(0, 4);
  if (!keywords.length) {
    return defaultTopicByLanguage(language);
  }

  return trimTopicTitle(keywords.join(" "), 56);
}

async function callJsonChat({ apiKey, model, baseUrl, systemPrompt, userPrompt, temperature = 0.7 }) {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      temperature,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ]
    })
  });

  if (!response.ok) {
    throw new Error(`OpenAI request failed with ${response.status}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || "";
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
    return trimTopicTitle(prompt, 56);
  }

  const broadHint = extractTopicHint(prompt, language);
  if (broadHint && isTextAlignedWithLanguage(broadHint, language)) {
    return trimTopicTitle(broadHint, 56);
  }

  const broadSubject = buildBroadSubjectFromPrompt(prompt, language);
  const subjectApiKey = process.env.OPENAI_API_KEY;
  const subjectModel = process.env.OPENAI_MODEL || "gpt-4.1-mini";
  const subjectBaseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  const outputLanguage = getOutputLanguageName(language);

  if (subjectApiKey) {
    try {
      const raw = await callJsonChat({
        apiKey: subjectApiKey,
        model: subjectModel,
        baseUrl: subjectBaseUrl,
        temperature: 0.3,
        systemPrompt: "Extract one broad subject from a creator brief. Do not choose a hidden angle, hook, or final episode title. Return valid JSON only.",
        userPrompt: [
          `Output language: ${outputLanguage}`,
          "Return valid JSON only in this shape:",
          '{"subject":""}',
          "",
          "Rules:",
          "- return one broad seed subject only",
          "- keep it short",
          "- do not finalize the topic",
          "- do not add dramatic framing",
          "",
          "Creator prompt:",
          prompt
        ].join("\n")
      });
      const parsed = JSON.parse(raw);
      const subject = trimTopicTitle(parsed?.subject || "", 56);
      if (subject) {
        return subject;
      }
    } catch {
      // fall back below
    }
  }

  try {
    const trends = await fetchTrendCandidates(language);
    const selectedTrend = trimTopicTitle(pickBestTrend(prompt, trends), 56);
    if (selectedTrend) {
      return selectedTrend;
    }
  } catch {
    // fall back below
  }

  return broadSubject || fallback || defaultTopicByLanguage(language);
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
      ? `"${topic}" 湲곗??쇰줈 ??ν뻽?듬땲?? ?곗꽑 蹂??좏샇??${headline} ?낅땲??`
      : `"${topic}" 湲곗??쇰줈 由ъ꽌移섎? ??ν뻽?듬땲??`;
  }

  return headline
    ? `"${topic}" 湲곗??쇰줈 由ъ꽌移섎? ?뺣━?덉뒿?덈떎. ?곗꽑 蹂??좏샇??${headline}?낅땲??`
    : `"${topic}" 湲곗??쇰줈 由ъ꽌移섎? ??ν뻽?듬땲??`;
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

  return language === "en" ? "No scout result was generated." : "?ㅽ넗由??ㅼ뭅?고듃 寃곌낵媛 ?놁뒿?덈떎.";
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
      whyItGrabsAttention: `${idea} ?먯껜??媛덈벑怨?諛섏쟾??蹂댁뿬??諛붾줈 沅곴툑利앹쓣 留뚮뱾 ???덉뒿?덈떎.`,
      whyItWouldMakeAGreatVideo: `${resolvedTopic}? ?곌껐??湲멸쾶 ?湲??쎄퀬, ?쇰컲 ?쒖껌?먮룄 ?댄빐?섍린 醫뗭? ?댁빞湲?援ъ“瑜?留뚮뱾 ???덉뒿?덈떎.`,
      suggestedHookAngle: `${idea}媛 ???앷컖蹂대떎 ???댁긽?섍퀬 ?꾪뿕???댁빞湲곗씤吏 ??以꾨줈 癒쇱? ?섏?硫?醫뗭뒿?덈떎.`
    };
  });
}

function buildAngleDiscoveryPrompt({ topicPrompt, subject, language, trendIdeas }) {
  const outputLanguage = getOutputLanguageName(language);

  return [
    'You are an angle discovery editor for a YouTube longform channel called "Signal Trigger."',
    "",
    "Do not finalize the topic too early.",
    "First explore multiple hidden angles inside the subject.",
    "Then reject obvious, generic, dry, textbook, and predictable angles.",
    "Then choose the single best final angle for a 10-20 minute story-driven video.",
    "",
    "Optimize for:",
    "- hidden angle",
    "- story potential",
    "- human drama",
    "- curiosity",
    "- less predictable framing",
    "- easy explanation for normal viewers",
    "",
    "Avoid:",
    "- dry politics",
    "- textbook framing",
    "- generic history summary",
    "- safe mainstream angle",
    "- jargon-heavy choices",
    "",
    "Return valid JSON only in this shape:",
    '{"angles":[{"angleTitle":"","whyInteresting":"","humanDrama":"","hookAngle":"","curiosityScore":0,"storyPotentialScore":0,"clarityScore":0,"predictabilityScore":0}]}',
    "",
    `Write all text in ${outputLanguage}.`,
    "Generate 12 angles.",
    "",
    "Input:",
    `Broad subject: ${normalizeText(subject) || "none"}`,
    `Creator seed: ${normalizeText(topicPrompt) || "none"}`,
    `Trend signals: ${trendIdeas.join(" | ") || "none"}`
  ].join("\n");
}

function clampScore(value) {
  const score = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(score)) {
    return 5;
  }

  return Math.max(1, Math.min(10, score));
}

function parseAngleDiscovery(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed?.angles)) {
      return [];
    }

    return parsed.angles
      .map((item) => ({
        angleTitle: trimTopicTitle(item?.angleTitle || "", 96),
        whyInteresting: normalizeText(item?.whyInteresting),
        humanDrama: normalizeText(item?.humanDrama),
        hookAngle: normalizeText(item?.hookAngle),
        curiosityScore: clampScore(item?.curiosityScore),
        storyPotentialScore: clampScore(item?.storyPotentialScore),
        clarityScore: clampScore(item?.clarityScore),
        predictabilityScore: clampScore(item?.predictabilityScore)
      }))
      .filter((item) => item.angleTitle);
  } catch {
    return [];
  }
}

function angleSelectionScore(angle) {
  return (
    angle.storyPotentialScore * 4 +
    angle.curiosityScore * 3 +
    angle.clarityScore * 2 -
    angle.predictabilityScore * 3
  );
}

function filterAngleCandidates(angles) {
  const filtered = angles.filter((angle) => (
    angle.storyPotentialScore >= 6 &&
    angle.curiosityScore >= 6 &&
    angle.clarityScore >= 5 &&
    angle.predictabilityScore <= 6
  ));

  return (filtered.length ? filtered : angles)
    .sort((left, right) => angleSelectionScore(right) - angleSelectionScore(left));
}

function buildRejectedAngles(discoveredAngles, filteredAngles) {
  const filteredTitles = new Set(filteredAngles.map((item) => item.angleTitle));
  return discoveredAngles.filter((item) => !filteredTitles.has(item.angleTitle));
}

function buildAngleSelectionPrompt({ subject, filteredAngles, language }) {
  const outputLanguage = getOutputLanguageName(language);

  return [
    'You are a final angle selector for a YouTube longform channel called "Signal Trigger."',
    "",
    "Choose exactly one final angle from the candidate list.",
    "Do not create a new angle.",
    "Do not pick the safest or most obvious angle.",
    "",
    "Selection priority:",
    "1. Most interesting hidden angle",
    "2. Strongest storytelling potential",
    "3. Least predictable angle",
    "4. Easy for normal viewers to understand",
    "5. Good for a 10-20 minute longform video",
    "",
    "Return valid JSON only in this shape:",
    '{"selectedAngleTitle":"","selectionReason":""}',
    "",
    `Write all text in ${outputLanguage}.`,
    "",
    `Broad subject: ${normalizeText(subject) || "none"}`,
    "Candidates:",
    filteredAngles.map((item, index) => [
      `${index + 1}. ${item.angleTitle}`,
      `- Why interesting: ${item.whyInteresting}`,
      `- Human drama: ${item.humanDrama}`,
      `- Hook: ${item.hookAngle}`,
      `- Scores: curiosity ${item.curiosityScore}, story ${item.storyPotentialScore}, clarity ${item.clarityScore}, predictability ${item.predictabilityScore}`
    ].join("\n")).join("\n\n")
  ].join("\n");
}

async function selectFinalAngle({ subject, filteredAngles, language, apiKey, model, baseUrl }) {
  if (!filteredAngles.length) {
    return null;
  }

  if (apiKey && filteredAngles.length > 1) {
    try {
      const raw = await callJsonChat({
        apiKey,
        model,
        baseUrl,
        temperature: 0.4,
        systemPrompt: "Select the single best final angle from the given candidates. Return valid JSON only.",
        userPrompt: buildAngleSelectionPrompt({ subject, filteredAngles, language })
      });
      const parsed = JSON.parse(raw);
      const selectedTitle = normalizeText(parsed?.selectedAngleTitle);
      const matched = filteredAngles.find((item) => normalizeText(item.angleTitle) === selectedTitle);
      if (matched) {
        return {
          ...matched,
          selectionReason: normalizeText(parsed?.selectionReason)
        };
      }
    } catch {
      // fall back below
    }
  }

  return {
    ...filteredAngles[0],
    selectionReason: "Highest weighted score after hidden-angle filtering."
  };
}

function buildFallbackAngleCandidates(subject, trendIdeas, language) {
  const seeds = trendIdeas.length ? trendIdeas : [subject];

  return seeds.slice(0, 12).map((seed, index) => {
    if (language === "en") {
      const templates = [
        `The old betrayal hidden inside ${seed}`,
        `The mistake that turned ${seed} into a bigger disaster`,
        `Why ${seed} keeps dragging rivals back into the same trap`,
        `The forgotten decision still poisoning ${seed}`,
        `The humiliation story behind ${seed}`,
        `The power grab nobody expected inside ${seed}`
      ];

      return {
        angleTitle: templates[index % templates.length],
        whyInteresting: `It turns ${seed} into a concrete story instead of a dry issue.`,
        humanDrama: `betrayal, fear, pride, revenge around ${seed}`,
        hookAngle: `Open with the one detail that makes ${seed} feel stranger than people expect.`,
        curiosityScore: 7,
        storyPotentialScore: 7,
        clarityScore: 7,
        predictabilityScore: 4
      };
    }

    return {
      angleTitle: `${seed} ?ㅼ뿉 ?⑥? ?ㅻ옒??媛덈벑`,
      whyInteresting: `${seed}瑜??깅뵳???ㅻ챸???꾨땲???댁빞湲곕줈 諛붽퓠?덈떎.`,
      humanDrama: `${seed} ?덉쓽 諛곗떊, ?먮젮?, ?먯〈?? 蹂듭닔`,
      hookAngle: `${seed}媛 ???앷컖蹂대떎 ?⑥뵮 ?ㅻ옒???댁빞湲곗씤吏 諛붾줈 ?щ뒗 諛⑹떇`,
      curiosityScore: 7,
      storyPotentialScore: 7,
      clarityScore: 7,
      predictabilityScore: 4
    };
  });
}

function buildAngleResearchPrompt({ subject, selectedAngle, language, trendIdeas }) {
  const outputLanguage = getOutputLanguageName(language);

  return [
    'You are a research writer for a YouTube longform channel called "Signal Trigger."',
    "",
    "Research starts only after the final angle has already been selected.",
    "Build a clean research brief around that selected angle.",
    "",
    "Return valid JSON only in this shape:",
    '{"summary":"","hiddenPastStory":"","keyPastEvents":[""],"researchNotes":[""]}',
    "",
    `Write all text in ${outputLanguage}.`,
    "",
    "Rules:",
    "- focus on the selected angle, not the broader subject",
    "- keep it story-driven and easy to understand",
    "- list key past events in causal order",
    "- avoid textbook tone and jargon",
    "",
    "Input:",
    `Broad subject: ${normalizeText(subject) || "none"}`,
    `Selected final angle: ${normalizeText(selectedAngle?.angleTitle) || "none"}`,
    `Why this angle is interesting: ${normalizeText(selectedAngle?.whyInteresting) || "none"}`,
    `Human drama: ${normalizeText(selectedAngle?.humanDrama) || "none"}`,
    `Hook angle: ${normalizeText(selectedAngle?.hookAngle) || "none"}`,
    `Trend signals: ${trendIdeas.join(" | ") || "none"}`
  ].join("\n");
}

function parseAngleResearch(raw) {
  try {
    const parsed = JSON.parse(raw);
    return {
      summary: normalizeText(parsed?.summary),
      hiddenPastStory: normalizeText(parsed?.hiddenPastStory),
      keyPastEvents: Array.isArray(parsed?.keyPastEvents)
        ? parsed.keyPastEvents.map((item) => normalizeText(item)).filter(Boolean).slice(0, 12)
        : [],
      researchNotes: Array.isArray(parsed?.researchNotes)
        ? parsed.researchNotes.map((item) => normalizeText(item)).filter(Boolean).slice(0, 8)
        : []
    };
  } catch {
    return {
      summary: "",
      hiddenPastStory: "",
      keyPastEvents: [],
      researchNotes: []
    };
  }
}

function buildAngleDiscoverySummary(subject, selectedAngle, filteredAngles, language) {
  const candidates = filteredAngles.slice(0, 5).map((item, index) => `${index + 1}. ${item.angleTitle}`).join("\n");

  if (language === "en") {
    return [
      `Subject: ${subject}`,
      `Selected angle: ${selectedAngle?.angleTitle || subject}`,
      "",
      "Top discovered angles:",
      candidates || "None"
    ].join("\n");
  }

  return [
    `二쇱젣: ${subject}`,
    `?좏깮 媛곷룄: ${selectedAngle?.angleTitle || subject}`,
    "",
    "?곸쐞 諛쒓껄 媛곷룄:",
    candidates || "?놁쓬"
  ].join("\n");
}

function buildFallbackAngleResearch(subject, selectedAngle, language) {
  if (language === "en") {
    return {
      summary: `${selectedAngle.angleTitle} works because it turns ${subject} into a concrete, dramatic story instead of a generic explainer.`,
      hiddenPastStory: `Behind ${selectedAngle.angleTitle} is an older chain of fear, pride, miscalculation, and memory that never really disappeared.`,
      keyPastEvents: [
        `The first major decision that set ${subject} on the wrong path`,
        `The humiliation or betrayal that hardened positions`,
        `The escalation that made compromise harder`,
        `The moment outside powers changed the balance`,
        `The trigger that brought the old tension back into the present`
      ],
      researchNotes: [
        selectedAngle.whyInteresting,
        selectedAngle.humanDrama,
        selectedAngle.hookAngle
      ].filter(Boolean)
    };
  }

  return {
    summary: `${selectedAngle.angleTitle}는 ${subject} 안에 숨은 이야기 각도입니다.`,
    hiddenPastStory: `${selectedAngle.angleTitle} 뒤에는 오래된 감정, 계산, 기억이 남아 있습니다.`,
    keyPastEvents: [
      `${subject}의 방향을 바꾼 첫 결정`,
      "입장을 굳힌 배신 또는 굴욕",
      "사태를 더 어렵게 만든 오판 장면",
      "힘의 균형을 바꾼 순간",
      "과거 긴장이 현재로 다시 터져 나온 계기"
    ],
    researchNotes: [
      selectedAngle.whyInteresting,
      selectedAngle.humanDrama,
      selectedAngle.hookAngle
    ].filter(Boolean)
  };
}

export async function fetchTrendIdeas({ topicPrompt, topic, language }) {
  const subject = trimTopicTitle(topic || "", 72)
    || await deriveTopicFromPrompt({ topicPrompt, language, fallbackTopic: topic });
  const angleApiKey = process.env.OPENAI_API_KEY;
  const angleModel = process.env.OPENAI_MODEL || "gpt-4.1-mini";
  const angleBaseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";

  try {
    const trendIdeas = (await fetchTrendCandidates(language))
      .sort((left, right) => historyPriorityScore(right) - historyPriorityScore(left))
      .slice(0, 15);

    let discoveredAngles = [];

    if (angleApiKey) {
      try {
        const rawDiscovery = await callJsonChat({
          apiKey: angleApiKey,
          model: angleModel,
          baseUrl: angleBaseUrl,
          temperature: 0.9,
          systemPrompt: "Discover story-rich hidden angles inside a broad subject. Return valid JSON only.",
          userPrompt: buildAngleDiscoveryPrompt({
            topicPrompt,
            subject,
            language,
            trendIdeas
          })
        });
        discoveredAngles = parseAngleDiscovery(rawDiscovery).slice(0, 12);
      } catch {
        // fall back below
      }
    }

    if (!discoveredAngles.length) {
      discoveredAngles = buildFallbackAngleCandidates(subject, trendIdeas, language).slice(0, 12);
    }

    const filteredAngles = filterAngleCandidates(discoveredAngles);
    const rejectedAngles = buildRejectedAngles(discoveredAngles, filteredAngles);
    const selectedAngle = await selectFinalAngle({
      subject,
      filteredAngles,
      language,
      apiKey: angleApiKey,
      model: angleModel,
      baseUrl: angleBaseUrl
    }) || filteredAngles[0] || discoveredAngles[0] || {
      angleTitle: subject,
      whyInteresting: "",
      humanDrama: "",
      hookAngle: "",
      curiosityScore: 5,
      storyPotentialScore: 5,
      clarityScore: 5,
      predictabilityScore: 5,
      selectionReason: ""
    };

    let researchBrief;

    if (angleApiKey) {
      try {
        const rawResearch = await callJsonChat({
          apiKey: angleApiKey,
          model: angleModel,
          baseUrl: angleBaseUrl,
          temperature: 0.6,
          systemPrompt: "Create a research brief for one selected story angle. Return valid JSON only.",
          userPrompt: buildAngleResearchPrompt({
            subject,
            selectedAngle,
            language,
            trendIdeas
          })
        });
        researchBrief = parseAngleResearch(rawResearch);
      } catch {
        researchBrief = buildFallbackAngleResearch(subject, selectedAngle, language);
      }
    } else {
      researchBrief = buildFallbackAngleResearch(subject, selectedAngle, language);
    }

    const ideas = researchBrief.keyPastEvents.length
      ? researchBrief.keyPastEvents
      : filteredAngles.slice(0, 8).map((item) => item.angleTitle);

    return {
      source: `angle-research-${normalizeLanguage(language).geo}`,
      subject,
      selectedTopic: selectedAngle.angleTitle || subject,
      selectedAngle,
      discoveredAngles,
      angleDiscovery: discoveredAngles,
      rejectedAngles,
      filteredAngles,
      ideas,
      summary: [
        buildAngleDiscoverySummary(subject, selectedAngle, filteredAngles, language),
        researchBrief.summary,
        researchBrief.hiddenPastStory
      ].filter(Boolean).join("\n\n"),
      researchNotes: researchBrief.researchNotes || []
    };
  } catch {
    const fallbackAngles = buildFallbackAngleCandidates(subject, [subject], language);
    const filteredAngles = filterAngleCandidates(fallbackAngles);
    const rejectedAngles = buildRejectedAngles(fallbackAngles, filteredAngles);
    const selectedAngle = await selectFinalAngle({
      subject,
      filteredAngles,
      language,
      apiKey: angleApiKey,
      model: angleModel,
      baseUrl: angleBaseUrl
    }) || filteredAngles[0] || fallbackAngles[0];
    const researchBrief = buildFallbackAngleResearch(subject, selectedAngle, language);

    return {
      source: `fallback-angle-research-${normalizeLanguage(language).geo}`,
      subject,
      selectedTopic: selectedAngle.angleTitle || subject,
      selectedAngle,
      discoveredAngles: fallbackAngles,
      angleDiscovery: fallbackAngles,
      rejectedAngles,
      filteredAngles,
      ideas: researchBrief.keyPastEvents,
      summary: [
        buildAngleDiscoverySummary(subject, selectedAngle, filteredAngles, language),
        researchBrief.summary,
        researchBrief.hiddenPastStory
      ].filter(Boolean).join("\n\n"),
      researchNotes: researchBrief.researchNotes || []
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
  "Your job is to turn a narration script into scene-by-scene AI image prompts that feel clean, vivid, pop, readable, and highly clickable.",
  "",
  "Use a simple prompt structure based on four parts: subject, style, composition and environment, details.",
  "",
  "The goal is to make every scene visually alive and engaging while still matching the story.",
  "",
  "The style should feel like:",
  "- flat vector illustration",
  "- thick dark outlines",
  "- rounded simple shapes",
  "- bright pastel pop palette",
  "- clean editorial cartoon look",
  "- modern app-style illustration",
  "- soft but vivid lighting",
  "- easy-to-read composition",
  "",
  "Core rules:",
  "1. Each prompt must clearly match the meaning and mood of the script section.",
  "2. Keep the subject clear and specific.",
  "3. Keep the style consistent across the whole video.",
  "4. Use composition that is simple, readable, and scroll-stopping.",
  "5. Use clean backgrounds with only the most important props.",
  "6. Use vivid but controlled color contrast, not muddy tones.",
  "7. If the scene is abstract, turn it into one instantly understandable visual metaphor.",
  "8. Avoid photo realism, messy detail, dark muddy textures, and overcomplicated staging.",
  "9. Avoid bland documentary realism, textbook illustration, childish comedy, anime style, superhero style, fantasy style, or random surrealism.",
  "10. Output prompts only.",
  "11. Write in English.",
  "",
  "Preferred visual elements when relevant:",
  "- simplified leaders confronting each other",
  "- bold maps and borders",
  "- clean crowd silhouettes",
  "- treaties, documents, flags, missiles, ports, war rooms",
  "- one strong symbolic prop when useful",
  "- simple interiors or exteriors with readable depth",
  "- expressive faces only when necessary",
  "",
  "Global visual baseline for every prompt:",
  "flat vector illustration, thick dark outline, rounded readable shapes, bright pastel pop palette, clean editorial cartoon style, minimal clutter, soft sunlight or soft studio light, gentle shading, crisp focal point, simple background depth, highly readable subject separation, modern clickable illustration",
  "",
  "Variety rule:",
  "Avoid weak portrait repetition. Use diverse visual subject matter such as maps, borders, documents, war rooms, ports, military hardware, monuments, trade routes, archives, cities, and interiors whenever they fit better than a face.",
  "Only use a human face as the main focus when a specific leader, diplomat, soldier, or crowd reaction is essential to the scene meaning."
].join("\n");

function buildSceneVisualAngle(paragraph, index) {
  const text = normalizeText(paragraph).toLowerCase();

  if (/(nuclear|missile|warhead|핵|미사일)/.test(text)) {
    return "missile silo, launch control room, nuclear map table, warning lights, geopolitical tension";
  }

  if (/(sanction|trade|economy|market|oil|gas|supply chain|제재|무역|경제|석유|가스)/.test(text)) {
    return "trade route map, cargo port, oil facility, currency chart, sanctions documents, industrial backdrop";
  }

  if (/(border|territory|sea|strait|navy|fleet|island|국경|영해|해협|함대)/.test(text)) {
    return "border checkpoint, contested sea map, naval vessels, surveillance view, strategic geography";
  }

  if (/(protest|revolution|uprising|riot|coup|정권|혁명|시위|쿠데타)/.test(text)) {
    return "street protest, state building, riot police silhouette, torn flags, regime pressure";
  }

  if (/(diplom|summit|negotiat|treaty|alliance|조약|정상회담|외교|협상|동맹)/.test(text)) {
    return "summit table, handshake under tension, treaty papers, flags, guarded diplomatic chamber";
  }

  if (/(history|empire|legacy|colonial|archival|historical|역사|제국|왕조)/.test(text)) {
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
    `Subject: ${normalizeText(topic) || "Global geopolitics"}, ${normalizeText(paragraph)}`,
    "Style: flat vector illustration, thick dark outlines, rounded simple shapes, bright pastel pop colors, clean editorial cartoon, modern app illustration",
    `Composition and environment: ${buildSceneVisualAngle(paragraph, index)}, ${format === "landscape" ? "16:9 wide composition" : "9:16 vertical composition"}, one clear focal subject, simple readable background`,
    `Details: ${normalizeText(tone) || "serious, clear, lively"}, ${colors.join(", ")}, soft lighting, crisp facial expression only if needed, avoid clutter, avoid single-person portrait unless essential`,
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
    `이번 영상에서는 ${safeTopic}를 약 ${minutes}분 분량으로 쉽게 풀어갑니다.`,
    `${safeTopic}를 추상적으로 설명하지 않고 ${ideas.join(", ") || "최근 시청자 질문"}과 연결해서 왜 지금 봐야 하는지부터 짚습니다.`
  ];

  for (let index = 0; index < bodyCount; index += 1) {
    const idea = ideas[index % Math.max(ideas.length, 1)] || safeTopic;
    paragraphs.push(
      `${idea}를 중심으로 현재 상황, 중요한 이유, 앞으로의 전개, 그리고 시청자가 바로 이해해야 할 포인트를 ${tone || "정보형"} 톤으로 설명합니다.`
    );
  }

  paragraphs.push("마지막에는 오늘 이슈의 의미와 다음에 볼 변수까지 자연스럽게 정리합니다.");

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
    "\"So THAT?셎 why this is happening.\"",
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
    "1. Hook the viewer immediately in the first 2?? sentences.",
    "2. The first 30 seconds must feel like the opening of a dangerous secret from history, not a normal news explanation.",
    "3. Do NOT begin with generic context, definitions, or broad statements.",
    "4. Do NOT start with ?쏧n today?셲 video??or anything similar.",
    "5. Start with tension, irony, shock, betrayal, danger, or a question that instantly creates curiosity.",
    "6. The opening should feel like:",
    "   - a buried grudge resurfacing",
    "   - an old betrayal exploding into the present",
    "   - a forgotten decision that poisoned the future",
    "7. Write like you are telling the viewer the true story behind today?셲 headline ??the part most people never hear.",
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
    "19. The final section should make today?셲 headline feel tragic, inevitable, or deeply unsettling.",
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
    "- Do not label sections such as Intro, Body, Conclusion, ?명듃濡? 蹂몃줎, 寃곕줎",
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

  return `현재 장면 수는 ${project.scenes.length}개이고 프로젝트 상태는 ${project.status}입니다. 질문을 구체적으로 입력하시면 바로 안내해 드립니다.`;
}

