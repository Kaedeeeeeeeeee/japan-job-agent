import type {
  CompensationFact,
  LanguageFact,
  LocationFact,
  SkillFact,
} from "./deterministic-job-parser.js";

const PREFECTURES = [
  "北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県", "茨城県", "栃木県", "群馬県", "埼玉県",
  "千葉県", "東京都", "神奈川県", "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県", "岐阜県", "静岡県",
  "愛知県", "三重県", "滋賀県", "京都府", "大阪府", "兵庫県", "奈良県", "和歌山県", "鳥取県", "島根県", "岡山県",
  "広島県", "山口県", "徳島県", "香川県", "愛媛県", "高知県", "福岡県", "佐賀県", "長崎県", "熊本県", "大分県",
  "宮崎県", "鹿児島県", "沖縄県",
] as const;

export function normalizeEmploymentValues(input: string): string[] {
  const values: string[] = [];
  const patterns: Array<[string, RegExp]> = [
    ["permanent", /正社員|正規社員|permanent\s+employee|full[- ]time/i],
    ["fixed_term", /契約社員|有期雇用|fixed[- ]term|contract\s+employee/i],
    ["dispatch", /派遣社員|dispatch\s+worker|temporary\s+staff/i],
    ["independent_contractor", /業務委託|請負|independent\s+contractor|freelance/i],
    ["part_time", /アルバイト|パート(?!ナー)|part[- ]time/i],
    ["ses_on_site", /SES常駐|客先常駐/i],
  ];
  const normalized = input.trim().toUpperCase();
  if (normalized === "FULL_TIME") values.push("permanent");
  if (normalized === "PART_TIME") values.push("part_time");
  if (normalized === "CONTRACTOR") values.push("independent_contractor");
  if (normalized === "TEMPORARY") values.push("fixed_term");
  for (const [value, pattern] of patterns) if (pattern.test(input) && !values.includes(value)) values.push(value);
  return values;
}

export function normalizeLocationText(input: string): LocationFact | null {
  const addressText = input.replace(/\s+/g, " ").trim();
  if (addressText === "") return null;
  const countryCode = inferCountryCode(addressText);
  const prefecture = PREFECTURES.find((candidate) => addressText.includes(candidate))
    ?? (/\bTokyo\b/i.test(addressText) ? "東京都"
      : /\bOsaka\b/i.test(addressText) ? "大阪府"
        : /\bFukuoka\b/i.test(addressText) ? "福岡県"
          : /\bKanagawa\b/i.test(addressText) ? "神奈川県" : null);
  const city = prefecture === null ? null : addressText.slice(addressText.indexOf(prefecture) + prefecture.length)
    .match(/^\s*([^\s,，]{1,20}?(?:市|区|町|村|郡))/)?.[1] ?? null;
  const remote = /フルリモート|完全在宅|fully\s+remote|remote[- ]first/i.test(addressText);
  const anyRemote = remote || /リモート|在宅|自宅|telecommute|remote/i.test(addressText);
  const japanRemote = remote && !/(worldwide|global|海外|国外)/i.test(addressText);
  if (countryCode === null && prefecture === null && !anyRemote && !looksLikeAddress(addressText)) return null;
  return {
    countryCode: countryCode ?? (prefecture === null ? null : "JP"),
    prefecture,
    city,
    addressText,
    remoteScope: anyRemote ? (japanRemote || /国内|日本全国|全国どこでも/i.test(addressText) ? "japan" : "unspecified") : null,
  };
}

export function inferCountryCode(value: string): string | null {
  if (PREFECTURES.some((prefecture) => value.includes(prefecture))) return "JP";
  const countries: Array<[string, RegExp]> = [
    ["JP", /\bJP\b|Japan|日本|Tokyo|東京|Fukuoka|福岡|Osaka|大阪|Kanagawa|神奈川|Chiba|千葉|Saitama|埼玉/i],
    ["TW", /Taiwan|Taipei|台湾|台北/i], ["KR", /South Korea|Korea|Seoul|韓国|ソウル/i],
    ["CN", /China|Beijing|Shanghai|中国|北京|上海/i], ["US", /United States|USA|San Francisco|New York|Florida|Washington,? DC|Virginia|California/i],
    ["GB", /United Kingdom|\bUK\b|London/i], ["NL", /Netherlands|Amsterdam/i], ["VN", /Vietnam|Hồ Chí Minh/i],
    ["TR", /Türkiye|Turkey|Istanbul/i], ["BR", /Brazil|São Paulo/i], ["SG", /Singapore/i],
    ["TH", /Thailand|Bangkok/i], ["HK", /Hong Kong/i], ["IN", /India|Bangalore|Bengaluru|Gurugram/i],
    ["AU", /Australia|Melbourne|Sydney/i], ["DE", /Germany|Berlin|Munich/i], ["FR", /France|Paris/i],
  ];
  return countries.find(([, pattern]) => pattern.test(value))?.[0] ?? null;
}

export function normalizeCompensationText(input: string): CompensationFact[] {
  const compact = input.replace(/[\u00a0\s]+/g, " ");
  const units: Array<{ period: CompensationFact["period"]; marker: RegExp }> = [
    { period: "year", marker: /年収|年俸|annual/i },
    { period: "month", marker: /月給|基本給|monthly|\/\s*month/i },
    { period: "day", marker: /日給|daily|\/\s*day/i },
    { period: "hour", marker: /時給|hourly|\/\s*hour/i },
  ];
  for (const unit of units) {
    const markerMatch = unit.marker.exec(compact);
    if (markerMatch === null) continue;
    const window = compact.slice(markerMatch.index, markerMatch.index + 180);
    const rangeMan = /([0-9]{1,4}(?:\.[0-9]+)?)\s*万\s*([0-9]{1,4})?\s*円?\s*(?:[〜～~\-–—]|から|to)\s*([0-9]{1,4}(?:\.[0-9]+)?)\s*万\s*([0-9]{1,4})?\s*円?/i.exec(window);
    if (rangeMan?.[1] !== undefined && rangeMan[3] !== undefined) {
      const minimum = manYen(rangeMan[1], rangeMan[2]);
      const maximum = manYen(rangeMan[3], rangeMan[4]);
      return validRange(minimum, maximum) ? [compensation(unit.period, minimum, maximum, compact)] : [];
    }
    const rangeYen = /[￥¥]?\s*((?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,9}))\s*円?\s*(?:[〜～~\-–—]|から|to)\s*[￥¥]?\s*((?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,9}))\s*円?/i.exec(window);
    if (rangeYen?.[1] !== undefined && rangeYen[2] !== undefined) {
      const minimum = yen(rangeYen[1]);
      const maximum = yen(rangeYen[2]);
      return validRange(minimum, maximum) ? [compensation(unit.period, minimum, maximum, compact)] : [];
    }
    const singleMan = /([0-9]{1,4}(?:\.[0-9]+)?)\s*万\s*([0-9]{1,4})?\s*円?/i.exec(window);
    if (singleMan?.[1] !== undefined) {
      const amount = manYen(singleMan[1], singleMan[2]);
      return [compensation(unit.period, amount, amount, compact)];
    }
    const singleYen = /[￥¥]?\s*([0-9]{2,9}(?:,[0-9]{3})*)\s*円/i.exec(window);
    if (singleYen?.[1] !== undefined) {
      const amount = yen(singleYen[1]);
      return [compensation(unit.period, amount, amount, compact)];
    }
  }
  const monthlyK = /[￥¥]\s*(\d{2,4})\s*K\s*(?:[〜～~\-]|to)\s*[￥¥]?\s*(\d{2,4})\s*K\s*\/\s*Month/i.exec(compact);
  if (monthlyK?.[1] !== undefined && monthlyK[2] !== undefined) {
    const minimum = Number(monthlyK[1]) * 1_000;
    const maximum = Number(monthlyK[2]) * 1_000;
    return validRange(minimum, maximum) ? [compensation("month", minimum, maximum, compact)] : [];
  }
  return [];
}

export function normalizeLanguageFacts(input: string, requirementKind: LanguageFact["requirementKind"]): LanguageFact[] {
  const results: LanguageFact[] = [];
  const patterns: Array<[string, RegExp]> = [
    ["ja", /(JLPT\s*N[1-5]|日本語.{0,20}(?:ネイティブ|母語|ビジネス|日常会話|N[1-5])|Japanese\s*:?.{0,20}(?:native|business|conversational|N[1-5]))/gi],
    ["en", /(TOEIC\s*\d{3,4}|英語.{0,20}(?:ネイティブ|母語|ビジネス|日常会話)|English\s*:?.{0,20}(?:native|business|conversational))/gi],
    ["zh", /(中国語.{0,20}(?:ネイティブ|母語|ビジネス|日常会話)|Mandarin|Chinese)/gi],
  ];
  for (const [languageCode, pattern] of patterns) {
    for (const match of input.matchAll(pattern)) {
      results.push({ languageCode, minimumLevel: match[0].match(/N[1-5]|\d{3,4}|ネイティブ|母語|ビジネス|日常会話|native|business|conversational/i)?.[0] ?? null,
        requirementKind });
    }
  }
  return unique(results);
}

const SKILLS: Array<[string, RegExp]> = [
  ["typescript", /\bTypeScript\b/i], ["javascript", /\bJavaScript\b/i], ["react", /\bReact\b/i],
  ["next.js", /\bNext\.?js\b/i], ["node.js", /\bNode\.?js\b/i], ["python", /\bPython\b/i],
  ["java", /\bJava\b/i], ["go", /\bGo(?:lang)?\b/i], ["aws", /\bAWS\b/i], ["gcp", /\bGCP\b/i],
  ["docker", /\bDocker\b/i], ["kubernetes", /\bKubernetes\b/i], ["postgresql", /\bPostgreSQL\b/i],
  ["ai", /\bAI\b|人工知能/i], ["llm", /\bLLM\b|大規模言語モデル/i], ["ios", /\biOS\b/i],
  ["swift", /\bSwift\b/i], ["unity", /\bUnity\b/i],
  ["microsoft word", /Microsoft\s+Word|\bMS\s*Word\b|\bWord\b/i],
  ["microsoft excel", /Microsoft\s+Excel|\bMS\s*Excel\b|\bExcel\b/i],
  ["microsoft powerpoint", /Microsoft\s+PowerPoint|\bPowerPoint\b/i],
  ["excel vba", /Excel.{0,12}(?:VBA|マクロ)|\bVBA\b/i],
];

export function normalizeSkillFacts(input: string, requirementKind: SkillFact["requirementKind"]): SkillFact[] {
  const results: SkillFact[] = [];
  for (const [normalizedSkill, pattern] of SKILLS) {
    const match = pattern.exec(input);
    if (match === null) continue;
    results.push({ normalizedSkill, originalText: match[0], requirementKind });
  }
  return results;
}

function compensation(period: CompensationFact["period"], minimumAmount: number, maximumAmount: number, context: string): CompensationFact {
  return {
    compensationKind: /試用|研修|trial/i.test(context) ? "trial" : period === "year" ? "total" : "base",
    currency: "JPY", period, minimumAmount, maximumAmount, isCalculated: false,
  };
}

function yen(value: string): number {
  return Number(value.replaceAll(",", ""));
}

function manYen(man: string, remainder: string | undefined): number {
  return Number(man) * 10_000 + (remainder === undefined ? 0 : Number(remainder));
}

function validRange(minimum: number, maximum: number): boolean {
  return Number.isFinite(minimum) && Number.isFinite(maximum) && minimum <= maximum;
}

function looksLikeAddress(value: string): boolean {
  return /〒?\d{3}-?\d{4}|\d+丁目|\d+番地|\d+-\d+/.test(value);
}

function unique<T>(values: T[]): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = JSON.stringify(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
